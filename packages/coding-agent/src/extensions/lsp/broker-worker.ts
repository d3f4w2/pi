import { type LspBrokerIdentity, lspBrokerEndpoint } from "./broker-protocol.ts";
import { assertLocalBrokerEndpoint, LspBrokerServer } from "./broker-server.ts";

const encoded = process.argv[2];
if (!encoded) throw new Error("LSP broker worker 缺少配置。");
const identity = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as LspBrokerIdentity;
const endpoint = lspBrokerEndpoint(identity);
assertLocalBrokerEndpoint(endpoint);
const broker = new LspBrokerServer({ identity, endpoint, onClose: () => process.exit(0) });
await broker.listen();

const close = () => void broker.close();
process.once("SIGTERM", close);
process.once("SIGINT", close);
