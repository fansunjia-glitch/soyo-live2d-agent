import "dotenv/config";
import { callCustomizationApi, fail, parseArgs } from "./voice-tools.mjs";

const args = parseArgs(process.argv.slice(2));
const prefix = args.prefix ?? "soyo";
const pageSize = Number(args["page-size"] ?? 50);
const pageIndex = Number(args["page-index"] ?? 0);

if (args.help) {
  printUsage();
  process.exit(0);
}

if (!/^[A-Za-z0-9]{1,10}$/.test(prefix)) {
  fail("--prefix can only contain letters and numbers, up to 10 characters.");
}

const response = await callCustomizationApi({
  model: "voice-enrollment",
  input: {
    action: "list_voice",
    prefix,
    page_size: pageSize,
    page_index: pageIndex
  }
});

const voices = response?.output?.voice_list ?? [];
if (args.json) {
  console.log(JSON.stringify(response, null, 2));
} else if (voices.length === 0) {
  console.log(`No voices found for prefix "${prefix}".`);
} else {
  for (const voice of voices) {
    console.log([
      `voice_id=${voice.voice_id ?? ""}`,
      `status=${voice.status ?? ""}`,
      `target_model=${voice.target_model ?? ""}`,
      `gmt_create=${voice.gmt_create ?? ""}`
    ].join(" "));
  }
}

function printUsage() {
  console.log(`Usage:
  npm run voice:list -- --prefix soyo

Options:
  --prefix <name>       Voice prefix to search. Default: soyo
  --page-size <number>  Page size. Default: 50
  --page-index <number> Page index. Default: 0
  --json                Print the raw DashScope JSON response.
`);
}
