-- Skill overviews now run on the system model and are billed to no team, so
-- the setting naming a team to bill them to is retired. Historical ledger and
-- observability rows are left as they are.
DELETE FROM "skill_market_settings" WHERE "key" = 'overview.billing';
