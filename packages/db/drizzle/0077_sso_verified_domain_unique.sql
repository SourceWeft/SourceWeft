CREATE UNIQUE INDEX IF NOT EXISTS "sso_provider_verified_domain_unique"
ON "ssoProvider" ("domain")
WHERE "domainVerified" = true;
