declare namespace Cloudflare {
  interface Env {
    BUCKET?: R2Bucket;
    DATABASE_URL?: string;
    DB_HOST?: string;
    DB_PORT?: string;
    DB_USER?: string;
    DB_PASSWORD?: string;
    DB_NAME?: string;
    DB_SSL?: string;
    ADMIN_PASSWORD?: string;
    BOT_TOKEN?: string;
    BOT_REMINDERS?: string;
    TEST_API_USERNAME?: string;
    TEST_API_PASSWORD?: string;
    RUNNER_URL?: string;
    RUNNER_TOKEN?: string;
  }
}
