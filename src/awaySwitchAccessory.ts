import { Service, PlatformAccessory, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback } from 'homebridge';
import axios from 'axios';
import { EcobeeAPIPlatform } from './platform';
import { AuthTokenManager } from './auth-token-refresh';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class AwaySwitchAccessory {
	private service: Service;

	// Define constants for climate states
	private readonly CLIMATE_HOME = 'home';
	private readonly CLIMATE_AWAY = 'away';
	private readonly CLIMATE_SLEEP = 'sleep';

	constructor(
		private readonly platform: EcobeeAPIPlatform,
		private readonly accessory: PlatformAccessory,
	) {
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
		setInterval(async () => {
			const apiStatus = await this.checkStatusFromAPI();
			const currentState = this.mapClimateToSecurityState(apiStatus, false);  // explicit false for current state
			const targetState = this.mapClimateToSecurityState(apiStatus, true);    // explicit true for target state
			this.service.updateCharacteristic(this.platform.Characteristic.SecuritySystemCurrentState, currentState);
			this.service.updateCharacteristic(this.platform.Characteristic.SecuritySystemTargetState, targetState);
			this.platform.log.debug('Pushed updated current state to HomeKit:', apiStatus);
		}, 30 * 60 * 1000);
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
		try {
			return await request();
		} catch (error) {
			if (axios.isAxiosError(error)) {
				this.platform.log.error(`Ecobee API Error during ${operationType}:`, {
					status: error.response?.status,
					statusText: error.response?.statusText,
					data: error.response?.data,
					url: error.config?.url,
					method: error.config?.method,
				});

				// If we get a 500 error, wait a bit and retry once
				if (error.response?.status === 500) {
					this.platform.log.info(`Retrying ${operationType} after 500 error...`);
					await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
					return await request();
				}

				throw error; // Re-throw if not a 500 error
			} else {
				this.platform.log.error(`Non-Axios error during ${operationType}:`, error);
				throw error;
			}
		}
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
				await AuthTokenManager.getInstance().renewAuthToken();
			}
			const authToken = AuthTokenManager.getInstance().authToken;
			const selectionMatch = this.platform.config.thermostatSerialNumbers || '';
			const selectionType = selectionMatch ? 'thermostats' : 'registered';
	
			// Use setHold for all states (EXCLUDING home) as to _NOT_ override built-in schedule
			
			let theType = "setHold";
	 		if (climateRef === "home") {
	     			theType = "resumeProgram"
	 		} 
			
			const setHoldBody = {
				'selection': {
					'selectionType': selectionType,
					'selectionMatch': selectionMatch,
				},
				'functions': [
					{
						'type': 'theType',
						'params': {
							'holdType': 'indefinite',
							'holdClimateRef': climateRef,
						},
					},
				],
			};
	
			const setHoldRequest = await this.makeEcobeeRequest(
				() => axios.post('https://api.ecobee.com/1/thermostat?format=json', 
					setHoldBody, 
					{headers: {'Authorization': 'Bearer ' + authToken}},
				),
				`${climateRef.toUpperCase()} mode set`,
			);
			
			this.platform.log.info(`Set Ecobee to ${climateRef} with result: ${JSON.stringify(setHoldRequest.data)}`);
			
			if (setHoldRequest.data.status.code === 0) {
				// Add a small delay to allow the thermostat to process the hold
				await new Promise(resolve => setTimeout(resolve, 2000));
				
				// Double-check the current status to ensure it took effect
				const currentStatus = await this.checkStatusFromAPI();
				if (currentStatus !== climateRef) {
					this.platform.log.warn(`${climateRef.toUpperCase()} mode set succeeded but status check shows different state:`, currentStatus);
				}
				
				this.service.updateCharacteristic(
					this.platform.Characteristic.SecuritySystemCurrentState,
					targetState,
				);
				this.platform.log.debug(`Successfully updated to ${climateRef.toUpperCase()} state`);
			} else {
				throw new Error(`Failed to set ${climateRef.toUpperCase()} mode: ${JSON.stringify(setHoldRequest.data)}`);
			}
	
			callback(null);
		} catch (error) {
			this.platform.log.error('Failed to set state:', error);
			callback(error as Error);
		}
	}

	/**
	 * Handle GET requests for target state
	 */
	async getTargetState(callback: CharacteristicGetCallback) {
		const apiStatus = await this.checkStatusFromAPI();
		const state = this.mapClimateToSecurityState(apiStatus, true); // Add true for target state
		this.platform.log.debug('Get Target State ->', state);
		callback(null, state);
	}

	/**
	 * Handle GET requests for current state
	 */
	async getCurrentState(callback: CharacteristicGetCallback) {
		const apiStatus = await this.checkStatusFromAPI();
		const state = this.mapClimateToSecurityState(apiStatus, false); // Add false for current state
		this.platform.log.debug('Get Current State ->', state);
		callback(null, state);
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
				const queryRequest = await this.makeEcobeeRequest(
					() => axios.get(
						'https://api.ecobee.com/1/thermostat?format=json&body={"selection":{"selectionType":"registered","selectionMatch":"","includeEvents":true}}',
						{headers: {'Authorization': 'Bearer ' + authToken}},
					),
					'status check',
				);
				const queryData = queryRequest.data;

				if (!queryData || !queryData.thermostatList) {
					this.platform.log.error('Unexpected query data structure:', JSON.stringify(queryData));
					return this.CLIMATE_HOME;
				}
					
				const events = queryData.thermostatList[0].events;

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
