# Public job read limits

`GET /api/jobs` now reserves persistent limits before retrieving list or detail data: 60 reads per client IP per UTC hour and 2,000 reads per UTC day across all callers. It returns 429 with a readable legacy `{error:string}` response and Retry-After when exhausted. All responses are no-store so shared caches cannot bypass admission. POST publishing authentication is unchanged.

Apply database schema `013-public-read-limits.sql` and configure PUBLIC_READ_LIMIT_SALT with at least 32 random bytes via your credential manager **before deploying this companion change**. Missing configuration/storage fails closed with 503; this also prevents curated fallback from bypassing a failed limiter. Never commit the salt. No production migration or configuration change was performed by local implementation.

On Vercel, the adapter accepts only a valid single `x-vercel-forwarded-for` address, not caller-supplied generic forwarding headers. See [Vercel request headers](https://vercel.com/docs/headers/request-headers). Unsupported production hosts require a trusted adapter; nonproduction uses a fixed local identity. Only HMAC identifiers are persisted. Expired counters receive bounded cleanup; the tables contain no raw IPs.

The standalone FrontlaneJobs API lives in the sibling `jobsapi` repository and has separate API-key limits. Neither limiter caps all website SSR queries, failed requests to infrastructure, or provider spending. Hosting/database allowances are shared. The website preserves prior results and reports read-limit errors; mobile already preserves ApiError status and the readable response without signing out on 429.
