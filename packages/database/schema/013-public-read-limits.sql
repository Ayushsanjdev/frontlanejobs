CREATE TABLE IF NOT EXISTS public_read_limits (
  scope text NOT NULL,
  subject text NOT NULL,
  window_start timestamptz NOT NULL,
  reset_at timestamptz NOT NULL,
  count integer NOT NULL CHECK(count>=0),
  PRIMARY KEY(scope,subject,window_start)
);
CREATE INDEX IF NOT EXISTS public_read_limits_expiry ON public_read_limits(reset_at);
