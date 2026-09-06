import "dotenv/config";

const token = process.env.AGENT_ACCESS_TOKEN?.trim() ?? "";
const invalid = !token
  || token.length < 24
  || token === "replace-with-a-random-agent-access-token";

if (invalid) {
  process.stderr.write(
    "Refusing to bind Soyo Agent beyond localhost without a strong AGENT_ACCESS_TOKEN.\n"
    + "Generate one with: python3 -c 'import secrets; print(secrets.token_urlsafe(32))'\n"
  );
  process.exit(1);
}
