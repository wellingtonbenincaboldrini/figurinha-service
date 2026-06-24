const express = require("express");
const sharp = require("sharp");
const fetch = require("node-fetch");
const FormData = require("form-data");

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 3000;
const REMOVEBG_API_KEY = process.env.REMOVEBG_API_KEY;

const FUNDO_URL = "https://znnycpkxezeclssqvyhu.supabase.co/storage/v1/object/public/fotos-clientes/base%20sem%20camisa%20sem%20texto.png";
const CAMISA_URL = "https://znnycpkxezeclssqvyhu.supabase.co/storage/v1/object/public/fotos-clientes/camisa.png";

const CANVAS_W = 1029;
const CANVAS_H = 1528;
const GOLA_Y = 611;
const ROSTO_TOPO = 60;
const ROSTO_BASE = GOLA_Y + 80; // 691px — sobrepõe levemente na gola
const ROSTO_H = ROSTO_BASE - ROSTO_TOPO; // 631px
const ROSTO_W = 700;

function escaparXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/gerar-figurinha", async (req, res) => {
  try {
    const { fotoUrl, nome, dataNascimento, altura, peso, time } = req.body;
    if (!fotoUrl) return res.status(400).json({ erro: "fotoUrl obrigatorio" });

    console.log("Dados:", { nome, dataNascimento, altura, peso, time });

    // 1. Baixar foto
    const fotoBuffer = await fetch(fotoUrl).then(r => r.buffer());

    // 2. Remover fundo
    console.log("Removendo fundo...");
    const form = new FormData();
    form.append("image_file", fotoBuffer, { filename: "foto.jpg", contentType: "image/jpeg" });
    form.append("size", "auto");

    const rbgRes = await fetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: { "X-Api-Key": REMOVEBG_API_KEY, ...form.getHeaders() },
      body: form,
    });

    if (!rbgRes.ok) throw new Error("Remove.bg erro: " + await rbgRes.text());
    const semFundoBuffer = await rbgRes.buffer();

    // 3. Detectar bounding box
    const { data, info } = await sharp(semFundoBuffer)
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    let minX = info.width, maxX = 0, minY = info.height, maxY = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * 4 + 3] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    const pessoaW = maxX - minX;
    const pessoaH = maxY - minY;
    const centroX = (minX + maxX) / 2;

    // 4. Recortar só rosto+busto (topo com margem até ~50% da pessoa)
    const margemTopo = pessoaH * 0.08;
    const recorteY1 = Math.max(0, Math.round(minY - margemTopo));
    const recorteY2 = Math.min(info.height, Math.round(minY + pessoaH * 0.55));
    const recorteH = recorteY2 - recorteY1;
    const recorteW = Math.min(Math.round(pessoaW * 1.1), info.width);
    const recorteX1 = Math.max(0, Math.round(centroX - recorteW / 2));

    const bustoBuffer = await sharp(semFundoBuffer)
      .extract({ left: recorteX1, top: recorteY1, width: recorteW, height: recorteH })
      .png().toBuffer();

    // 5. Escalar para caber exatamente na área do rosto (ROSTO_W x ROSTO_H)
    const scale = Math.min(ROSTO_W / recorteW, ROSTO_H / recorteH);
    const finalW = Math.round(recorteW * scale);
    const finalH = Math.round(recorteH * scale);

    const bustoResized = await sharp(bustoBuffer)
      .resize(finalW, finalH, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toBuffer();

    // Centralizar horizontalmente, base alinhada em ROSTO_BASE
    const fotoLeft = Math.round((CANVAS_W - finalW) / 2);
    const fotoTop = ROSTO_BASE - finalH;

    console.log(`Pessoa: left=${fotoLeft}, top=${fotoTop}, w=${finalW}, h=${finalH}`);

    // 6. Baixar fundo e camisa
    const [fundoBuffer, camisaBuffer] = await Promise.all([
      fetch(FUNDO_URL).then(r => r.buffer()),
      fetch(CAMISA_URL).then(r => r.buffer()),
    ]);

    // 7. Gerar textos via SVG
    const nomeTexto = escaparXml(String(nome || "").toUpperCase());
    const timeTexto = escaparXml(String(time || "").toUpperCase());
    const dataTexto = escaparXml(`${dataNascimento || ""} | ${altura || ""} | ${peso || ""}`);

    const svgTextos = `<svg width="${CANVAS_W}" height="${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">
      <text x="514" y="1255" font-family="Liberation Sans, DejaVu Sans, sans-serif" font-weight="bold" font-size="52" fill="white" text-anchor="middle">${nomeTexto}</text>
      <text x="514" y="1300" font-family="Liberation Sans, DejaVu Sans, sans-serif" font-size="28" fill="white" text-anchor="middle">${dataTexto}</text>
      <text x="360" y="1355" font-family="Liberation Sans, DejaVu Sans, sans-serif" font-weight="bold" font-size="30" fill="white" text-anchor="middle">${timeTexto}</text>
    </svg>`;

    // 8. Montar: fundo → pessoa → camisa → textos
    const figurinha = await sharp(fundoBuffer)
      .resize(CANVAS_W, CANVAS_H)
      .composite([
        { input: bustoResized, left: fotoLeft, top: fotoTop },
        { input: camisaBuffer, left: 0, top: 0 },
        { input: Buffer.from(svgTextos), left: 0, top: 0 },
      ])
      .png().toBuffer();

    console.log("Figurinha gerada:", figurinha.length, "bytes OK");
    res.json({ imagemBase64: figurinha.toString("base64"), tipo: "png" });

  } catch (err) {
    console.error("ERRO:", err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
