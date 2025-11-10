# Changelog

All notable changes to this project will be documented in this file.

## [2.1.13] - 2025-11-10

### Fixed
- Status polling now correctly respects configured thermostat serial numbers instead of always using the first thermostat
- Fixed API request encoding for thermostat selection
- Improved code quality and type safety

## [2.1.12] - 2025-07-22

### Fixed
- Improved network error handling by implementing NetworkRetry for all Ecobee API calls
- Fixed ETIMEDOUT and ENETUNREACH errors during network connectivity issues
- Added exponential backoff with proper retry logic for transient network failures

## [2.1.11] - 2025-06-17

### Fixed
- Improved handling of Ecobee API rate limits (429 errors)
- Added exponential backoff for rate limited requests
- Prevented cascading retry attempts during rate limiting
- Fixed duplicate background refresh scheduling

### Added
- Configurable status polling interval (30-1440 minutes)
- Better error messages for rate limiting scenarios
- Rate limit awareness in token refresh logic

### Changed
- Default polling interval increased from 30 to 60 minutes
- Reduced retry attempts for auth endpoints to prevent rate limits
- Increased initial retry delay for auth endpoints to 30 seconds
