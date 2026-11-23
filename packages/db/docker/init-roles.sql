-- Local development roles (production roles are created by infrastructure code).
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE ROLE venueos_app LOGIN PASSWORD 'app_password';
CREATE ROLE venueos_jobs LOGIN PASSWORD 'jobs_password' BYPASSRLS;
GRANT CONNECT ON DATABASE venueos TO venueos_app, venueos_jobs;
GRANT USAGE ON SCHEMA public TO venueos_app, venueos_jobs;
-- Tables created later by the migrator get DML grants automatically:
ALTER DEFAULT PRIVILEGES FOR ROLE venueos_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO venueos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE venueos_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO venueos_jobs;
ALTER DEFAULT PRIVILEGES FOR ROLE venueos_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO venueos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE venueos_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO venueos_app, venueos_jobs;
