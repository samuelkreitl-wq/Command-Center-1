import { startServer } from "./http";

const port = Number(process.env.PORT || 5000);
startServer(port, "0.0.0.0").then(({ port: bound }) => {
  console.log(`money os desk listening on http://0.0.0.0:${bound}`);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
