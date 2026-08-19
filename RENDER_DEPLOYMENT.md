# Friends Traders: Render deployment

Use the existing build command:

```text
pip install -r requirements.txt
```

Use the existing start command:

```text
gunicorn app:app --bind 0.0.0.0:$PORT --timeout 120 --workers 1
```

Set these Render environment variables (do not commit them):

```text
SECRET_KEY=<a-new-long-random-value>
OWNER_EMAIL=<owner-email>
OWNER_PASSWORD=<strong-owner-password>
AI_ASSISTANT_ENABLED=true
GROQ_API_KEY=<Groq-API-key>
GROQ_MODEL=openai/gpt-oss-20b
AI_REQUEST_TIMEOUT_SECONDS=20
```

`DATABASE_URL` is strongly recommended for persistent products, orders, and users. Render's local filesystem is ephemeral; do not rely on the default SQLite database for production data.

After deployment, open `/api/public-config`. `ai_assistant_enabled` must be `true`. If a provider request fails, Render now logs a safe diagnostic status such as `HTTP 401`, `HTTP 429`, or `HTTP 400`, rather than hiding the cause behind a generic warning.
