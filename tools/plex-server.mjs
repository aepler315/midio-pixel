import { readPlexConfig } from "./plex/config.mjs";
import { createPlexClient } from "./plex/client.mjs";
import { createPlexServer } from "./plex/server.mjs";
const config = readPlexConfig();
try {
  const server = createPlexServer({ config, client: createPlexClient(config) });
  await server.ready;
  server.listen(config.port, config.host, () =>
    console.log(
      `Plex adapter listening on port ${config.port}; ${config.enabled ? "enabled" : "disabled"}`,
    ),
  );
  for (const name of ["SIGINT", "SIGTERM"])
    process.once(name, () => {
      server.close(() => process.exit(0));
      setTimeout(() => {
        server.closeAllConnections();
        process.exit(0);
      }, 3000).unref();
    });
} catch {
  console.error(
    "Plex adapter startup failed: check private configuration and approved music sections",
  );
  process.exitCode = 1;
}
