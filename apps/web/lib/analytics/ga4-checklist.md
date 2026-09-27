# GA4 checklist

Generated from `catalog.ts` by `catalog.test.ts`. Register these in GA4
(Admin → Custom definitions / Key events) before shipping events that use
them: registrations do not apply to data collected earlier.

## Custom dimensions (event scope)

- action
- app_version
- auth_type
- billing_interval
- command_used
- connector_type
- edition
- gmail_mode
- has_images
- has_sources
- kind
- method
- plan
- platform
- scope
- source
- surface

## Custom metrics

- seat_count
- skill_count
- source_count
- tool_count

## User properties

- platform

## Key events

- purchase
- sign_up
- begin_checkout (optional)
