import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { createDashScopeHeaders, fail, parseArgs } from "./voice-tools.mjs";

const args = parseArgs(process.argv.slice(2));
const text = args.text ?? "你好，我在这里。今天也请多指教。";
const instruction = args.instruction ?? "语气温柔、自然、稍微克制。";
const model = args.model ?? process.env.TTS_MODEL ?? "cosyvoice-v3.5-flash";
const voice = args.voice ?? process.env.TTS_VOICE ?? "longxiaochun";
const output = args.output ?? path.join("voice-tests", `tts-${Date.now()}.mp3`);

if (args.help) {
  printUsage();
  process.exit(0);
}

if (!text.trim()) {
  fail("--text cannot be empty.");
}

if (!voice.trim()) {
  fail("TTS_VOICE is required in .env or pass --voice.");
}

const audio = await synthesizeSpeech({
  text: text.trim(),
  instruction: instruction.trim(),
  model,
  voice
});

const outputPath = path.resolve(output);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, audio);

console.log(JSON.stringify({
  output: outputPath,
  bytes: audio.length,
  model,
  voice,
  text
}, null, 2));

async function synthesizeSpeech({ text: inputText, instruction: inputInstruction, model: inputModel, voice: inputVoice }) {
  const taskId = randomUUID();

  return await new Promise((resolve, reject) => {
    const chunks = [];
    const ws = new WebSocket("wss://dashscope.aliyuncs.com/api-ws/v1/inference/", {
      headers: {
        ...createDashScopeHeaders({ contentType: "" }),
        "X-DashScope-DataInspection": "enable"
      }
    });

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("DashScope TTS timed out."));
    }, 45_000);

    const finish = () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({
        header: {
          action: "run-task",
          task_id: taskId,
          streaming: "duplex"
        },
        payload: {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model: inputModel,
          parameters: {
            text_type: "PlainText",
            voice: inputVoice,
            format: "mp3",
            sample_rate: 24000,
            volume: 60,
            rate: 1.0,
            pitch: 1.0,
            enable_ssml: false,
            language_hints: ["zh"],
            ...(inputInstruction ? { instruction: inputInstruction.slice(0, 80) } : {})
          },
          input: {}
        }
      }));
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        chunks.push(Buffer.from(data));
        return;
      }

      const message = JSON.parse(data.toString());
      switch (message.header?.event) {
        case "task-started":
          ws.send(JSON.stringify({
            header: {
              action: "continue-task",
              task_id: taskId,
              streaming: "duplex"
            },
            payload: {
              input: { text: inputText }
            }
          }));
          ws.send(JSON.stringify({
            header: {
              action: "finish-task",
              task_id: taskId,
              streaming: "duplex"
            },
            payload: {
              input: {}
            }
          }));
          break;
        case "task-finished":
          ws.close();
          finish();
          break;
        case "task-failed":
          clearTimeout(timer);
          reject(new Error(message.header.error_message ?? message.header.error_code ?? "DashScope TTS task failed."));
          ws.close();
          break;
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function printUsage() {
  console.log(`Usage:
  npm run voice:test -- --text "你好，我在这里。"

Options:
  --text <text>               Text to synthesize.
  --instruction <text>        CosyVoice style instruction.
  --model <model>             TTS model. Default: TTS_MODEL or cosyvoice-v3.5-flash
  --voice <voice_id>          Voice ID. Default: TTS_VOICE
  --output <path>             MP3 output path. Default: voice-tests/tts-<timestamp>.mp3
`);
}
