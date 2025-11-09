// awaySwitchAccessory.ts
import { Service, PlatformAccessory, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback } from 'homebridge';
import axios from 'axios';
import { EcobeeAPIPlatform } from './platform';
import { AuthTokenManager } from './auth-token-refresh';
import { NetworkRetry } from './network-retry';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class AwaySwitchAccessory {
  private service: Service;
  private readonly networkRetry: NetworkRetry;

  // Define constants for climate states
  private readonly CLIMATE_HOME = 'home';
  private readonly CLIMATE_AWAY = 'away';
  private readonly CLIMATE_SLEEP = 'sleep';

  constructor(
    private readonly platform: EcobeeAPIPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    // Initialize NetworkRetry with appropriate settings for API calls
    this.networkRetry = new NetworkRetry({
      maxAttempts: 8,
      initialDelay: 15000, // 15 seconds
      maxDelay: 60000, // 1 minute
      backoffFactor: 2,
      retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH'],
    });

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ecobee')
      .setCharacteristic(this.platform.Characteristic.Model, 'Climate Controller')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'ECOBEEAWAY1');

    // Use SecuritySystem service instead of Switch
    this.service = this.accessory.getService(this.platform.Service.SecuritySystem)
      || this.accessory.addService(this.platform.Service.SecuritySystem);

    // Set the service name
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);

    // Register handlers for the SecuritySystemTargetState Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.SecuritySystemTargetState)
      .setProps({
        validValues: [
          this.platform.Characteristic.SecuritySystemTargetState.STAY_ARM,  // Home
          this.platform.Characteristic.SecuritySystemTargetState.AWAY_ARM,  // Away
          this.platform.Characteristic.SecuritySystemTargetState.NIGHT_ARM, // Sleep
        ],
      })
      .on('set', this.setTargetState.bind(this))
      .on('get', this.getTargetState.bind(this));

    // Register handlers for the SecuritySystemCurrentState Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.SecuritySystemCurrentState)
      .on('get', this.getCurrentState.bind(this));

    // Poll for updates
    const pollingMinutes = this.platform.config.statusPollingMinutes || 60;
    const pollingInterval = pollingMinutes * 60 * 1000;

    setInterval(async () => {
      try {
        const apiStatus = await this.checkStatusFromAPI();
        const currentState = this.mapClimateToSecurityState(apiStatus, false);  // explicit false for current state
        const targetState = this.mapClimateToSecurityState(apiStatus, true);    // explicit true for target state
        this.service.updateCharacteristic(this.platform.Characteristic.SecuritySystemCurrentState, currentState);
        this.service.updateCharacteristic(this.platform.Characteristic.SecuritySystemTargetState, targetState);
        this.platform.log.debug('Pushed updated current state to HomeKit:', apiStatus);
      } catch (error) {
        this.platform.log.debug('Failed to poll status:', error);
      }
    }, pollingInterval);
  }

  /**
   * Maps climate mode to HomeKit security system state
   */
  private mapClimateToSecurityState(climate: string, isTarget = false): number {
    switch (climate) {
      case this.CLIMATE_AWAY:
        return isTarget
          ? this.platform.Characteristic.SecuritySystemTargetState.AWAY_ARM
          : this.platform.Characteristic.SecuritySystemCurrentState.AWAY_ARM;
      case this.CLIMATE_SLEEP:
        return isTarget
          ? this.platform.Characteristic.SecuritySystemTargetState.NIGHT_ARM
          : this.platform.Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
      case this.CLIMATE_HOME:
      default:
        return isTarget
          ? this.platform.Characteristic.SecuritySystemTargetState.STAY_ARM
          : this.platform.Characteristic.SecuritySystemCurrentState.STAY_ARM;
    }
  }

  /**
   * Maps HomeKit security system state to climate mode
   */
  private mapSecurityToClimate(state: number): string {
    switch (state) {
      case this.platform.Characteristic.SecuritySystemTargetState.AWAY_ARM:
        return this.CLIMATE_AWAY;
      case this.platform.Characteristic.SecuritySystemTargetState.NIGHT_ARM:
        return this.CLIMATE_SLEEP;
      case this.platform.Characteristic.SecuritySystemTargetState.STAY_ARM:
      default:
        return this.CLIMATE_HOME;
    }
  }

  /**
   * Helper method to handle API requests with retry logic
   */
  private async makeEcobeeRequest<T>(request: () => Promise<T>, operationType: string): Promise<T> {
    return this.networkRetry.execute(
      request,
      this.platform.log,
      `Ecobee API ${operationType}`
    );
  }

  /**
   * Handle SET requests from HomeKit
   */
  async setTargetState(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    try {
      const targetState = value as number;
      const climateRef = this.mapSecurityToClimate(targetState);

      const needsRefresh = AuthTokenManager.getInstance().isExpired();
      if (needsRefresh) {
        const refreshedToken = await AuthTokenManager.getInstance().renewAuthToken();
        if (!refreshedToken) {
          throw new Error('Failed to refresh expired auth token');
        }
      }
      const authToken = AuthTokenManager.getInstance().authToken;
      const selectionMatch = this.platform.config.thermostatSerialNumbers || '';
      const selectionType = selectionMatch ? 'thermostats' : 'registered';

      // Determine if we should use indefinite hold based on the state
      let useIndefiniteHold = false;
      switch (climateRef) {
        case this.CLIMATE_HOME:
          useIndefiniteHold = this.platform.config.homeIndefiniteHold ?? false;
          break;
        case this.CLIMATE_AWAY:
          useIndefiniteHold = this.platform.config.awayIndefiniteHold ?? true;
          break;
        case this.CLIMATE_SLEEP:
          useIndefiniteHold = this.platform.config.sleepIndefiniteHold ?? true;
          break;
      }

      let requestBody;
      if (useIndefiniteHold) {
        // Use setHold with indefinite hold
        requestBody = {
          'selection': {
            'selectionType': selectionType,
            'selectionMatch': selectionMatch,
          },
          'functions': [
            {
              'type': 'setHold',
              'params': {
                'holdType': 'indefinite',
                'holdClimateRef': climateRef,
              },
            },
          ],
        };
      } else {
        // Use resumeProgram
        requestBody = {
          'selection': {
            'selectionType': selectionType,
            'selectionMatch': selectionMatch,
          },
          'functions': [
            {
              'type': 'resumeProgram',
              'params': {
                'resumeAll': false,
              },
            },
          ],
        };
      }

      const response = await this.makeEcobeeRequest(
        () => axios.post(
          'https://api.ecobee.com/1/thermostat?format=json',
          requestBody,
          { headers: { 'Authorization': 'Bearer ' + authToken } },
        ),
        `${climateRef.toUpperCase()} mode set`,
      );

      this.platform.log.info(`Set Ecobee to ${climateRef} with result: ${JSON.stringify(response.data)}`);

      if (response.data.status.code === 0) {
        // Add a small delay to allow the thermostat to process the change
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Double-check the current status to ensure it took effect
        const currentStatus = await this.checkStatusFromAPI();
        if (currentStatus !== climateRef && useIndefiniteHold) {
          this.platform.log.warn(`${climateRef.toUpperCase()} mode set succeeded but status check shows different state:`, currentStatus);
        }

        this.service.updateCharacteristic(
          this.platform.Characteristic.SecuritySystemCurrentState,
          targetState,
        );
        this.platform.log.debug(`Successfully updated to ${climateRef.toUpperCase()} state`);
      } else {
        throw new Error(`Failed to set ${climateRef.toUpperCase()} mode: ${JSON.stringify(response.data)}`);
      }

      callback(null);
    } catch (error) {
      this.platform.log.error('Failed to set target state:', error);
      callback(error as Error);
    }
  }

  /**
   * Handle GET requests for target state
   */
  async getTargetState(callback: CharacteristicGetCallback) {
    try {
      const apiStatus = await this.checkStatusFromAPI();
      const state = this.mapClimateToSecurityState(apiStatus, true); // Add true for target state
      this.platform.log.debug('Get Target State ->', state);
      callback(null, state);
    } catch (error) {
      this.platform.log.error('Failed to get target state:', error);
      callback(error as Error);
    }
  }

  /**
   * Handle GET requests for current state
   */
  async getCurrentState(callback: CharacteristicGetCallback) {
    try {
      const apiStatus = await this.checkStatusFromAPI();
      const state = this.mapClimateToSecurityState(apiStatus, false); // Add false for current state
      this.platform.log.debug('Get Current State ->', state);
      callback(null, state);
    } catch (error) {
      this.platform.log.error('Failed to get current state:', error);
      callback(error as Error);
    }
  }

  /**
   * Check the current climate status from the Ecobee API
   */
  private async checkStatusFromAPI(): Promise<string> {
    try {
      const needsRefresh = AuthTokenManager.getInstance().isExpired();
      if (needsRefresh) {
        await AuthTokenManager.getInstance().renewAuthToken();
      }
      const authToken = AuthTokenManager.getInstance().authToken;

      try {
        // Use configured thermostat serial numbers when provided so we query the correct thermostat
        const selectionMatch = (this.platform.config as any).thermostatSerialNumbers || '';
        const selectionType = selectionMatch ? 'thermostats' : 'registered';

        const body = {
          selection: {
            selectionType,
            selectionMatch,
            includeEvents: true,
          },
        };

        // Log which selection is being queried so users with multiple thermostats can see what's polled
        try {
          this.platform.log.info(`Querying Ecobee thermostats - selectionType=${selectionType}, selectionMatch=${selectionMatch}`);
        } catch (err) {
          // ignore logging failures
        }
        const queryRequest = await this.makeEcobeeRequest(
          () => axios.get('https://api.ecobee.com/1/thermostat?format=json&body=' + encodeURIComponent(JSON.stringify(body)), { headers: { 'Authorization': 'Bearer ' + authToken } }),
          'status check',
        );
        const queryData = queryRequest.data;

        if (!queryData || !queryData.thermostatList) {
          this.platform.log.error('Unexpected query data structure:', JSON.stringify(queryData));
          return this.CLIMATE_HOME;
        }

        // If multiple thermostats are returned (registered selection), fall back to the first one.
        // When a specific serial is requested, the thermostatList should contain only the matching thermostat.
        const thermostat = queryData.thermostatList[0];
        const events = thermostat.events || [];

        if (events.length > 0) {
          const mostRecentEvent = events[0];
          return mostRecentEvent.holdClimateRef || this.CLIMATE_HOME;
        } else {
          return this.CLIMATE_HOME;
        }
      } catch (error) {
        this.platform.log.error('Failed to check status:', error);
        return this.CLIMATE_HOME;
      }
    } catch (error) {
      this.platform.log.error('Error in checkStatusFromAPI:', error);
      return this.CLIMATE_HOME;
    }
  }
}