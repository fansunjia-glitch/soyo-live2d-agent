import fs from "node:fs/promises";
import path from "node:path";

const server = "en";
const assetPath = "live2d/chara/039_casual-2023";
const baseUrl = "https://bestdori.com/assets";
const outDir = new URL("../public/models/soyo/bestdori/", import.meta.url);

const groups = {
  Idle: ["idle01"],
  TapBody: ["nf01", "nf02", "nf03", "nnf01", "nnf02", "nnf03"],
  Nod: ["kandou01"],
  Wave: ["bye01", "bye02"],
  Think: ["thinking01", "thinking02", "odoodo01"],
  Comfort: ["smile01", "smile02", "smile03", "smile04", "smile05"],
  Deny: ["angry01", "angry02", "angry03"],
  Excited: ["kime01", "smile06", "wink01"],
  Sad: ["sad01", "sad02", "sad03"],
  Surprised: ["surprised01"],
  Shy: ["shame01", "shame02"],
  Serious: ["serious01", "serious02", "serious03", "serious04"]
};

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const buildDataUrl = `${baseUrl}/${server}/${assetPath}_rip/buildData.asset`;
  const buildData = await fetchJson(buildDataUrl);
  const base = buildData.Base;

  await downloadAsset(base.model.bundleName, base.model.fileName.slice(0, -6), "");
  await downloadAsset(base.physics.bundleName, base.physics.fileName, "");

  for (const texture of base.textures) {
    await downloadAsset(texture.bundleName, ensureExt(texture.fileName, ".png"), "textures");
  }

  for (const motion of base.motions) {
    await downloadAsset(motion.bundleName, motion.fileName.slice(0, -6), "motions");
  }

  for (const expression of base.expressions) {
    await downloadAsset(expression.bundleName, expression.fileName, "expressions");
  }

  const modelJson = {
    version: "1.0.0",
    name: "Soyo Nagasaki",
    model: base.model.fileName.slice(0, -6),
    textures: base.textures.map((texture) => `textures/${ensureExt(texture.fileName, ".png")}`),
    physics: base.physics.fileName,
    motions: buildMotionGroups(base.motions),
    expressions: base.expressions.map((expression) => {
      const name = expression.fileName.replace(/\.exp\.json$/, "");
      return {
        name,
        file: `expressions/${expression.fileName}`
      };
    }),
    layout: {
      center_x: 0,
      center_y: 0,
      width: 2
    }
  };

  await fs.writeFile(new URL("model.json", outDir), `${JSON.stringify(modelJson, null, 2)}\n`);
  await fs.writeFile(new URL("SOURCE.md", outDir), [
    "# Soyo Bestdori Live2D",
    "",
    "Downloaded from Bestdori public asset URLs for local personal testing.",
    "",
    `Source build data: ${buildDataUrl}`,
    "",
    "Do not redistribute these assets unless you have the appropriate rights from the copyright holder."
  ].join("\n"));
}

function buildMotionGroups(motions) {
  const available = new Set(motions.map((motion) => motion.fileName.replace(/\.mtn\.bytes$/, "")));
  const result = {};

  for (const [group, names] of Object.entries(groups)) {
    const files = names
      .filter((name) => available.has(name))
      .map((name) => ({ file: `motions/${name}.mtn` }));
    if (files.length > 0) {
      result[group] = files;
    }
  }

  result.All = motions.map((motion) => ({
    file: `motions/${motion.fileName.slice(0, -6)}`
  }));

  return result;
}

async function downloadAsset(bundleName, fileName, subdir) {
  const targetDir = new URL(subdir ? `${subdir}/` : "./", outDir);
  await fs.mkdir(targetDir, { recursive: true });
  const url = `${baseUrl}/${server}/${bundleName}_rip/${fileName}`;
  const filePath = new URL(fileName, targetDir);
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, bytes);
  console.log(`downloaded ${path.relative(process.cwd(), filePath.pathname)}`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return await response.json();
}

function ensureExt(fileName, ext) {
  return fileName.endsWith(ext) ? fileName : `${fileName}${ext}`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
