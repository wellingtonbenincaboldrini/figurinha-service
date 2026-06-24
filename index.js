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
const COLARINHO_Y = 611;

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

    console.log("Dados recebidos:", { nome, dataNascimento, altura, peso, time });

    console.log("1. Baixando foto:", fotoUrl);
    const fotoRes = await fetch(fotoUrl);
    const fotoBuffer = await fotoRes.buffer();

    console.log("2. Removendo fundo via Remove.bg...");
    const form = new FormData();
    form.append("image_file", fotoBuffer, { filename: "foto.jpg", contentType: "image/jpeg" });
    form.append("size", "auto");

    const rbgRes = await fetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: { "X-Api-Key": REMOVEBG_API_KEY, ...form.getHeaders() },
      body: form,
    });

    if (!rbgRes.ok) {
      const err = await rbgRes.text();
      throw new Error("Remove.bg erro: " + err);
    }

    const semFundoBuffer = await rbgRes.buffer();

    console.log("3. Detectando bounding box da pessoa...");
    const rawData = await sharp(semFundoBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = rawData;
    const imgW = info.width;
    const imgH = info.height;

    let minX = imgW, maxX = 0, minY = imgH, maxY = 0;
    for (let y = 0; y < imgH; y++) {
      for (let x = 0; x < imgW; x++) {
        const alpha = data[(y * imgW + x) * 4 + 3];
        if (alpha > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    const pessoaW = maxX - minX;
    const pessoaH = maxY - minY;
    const rostoCentroX = (minX + maxX) / 2;

    // Recortar rosto + busto com margem generosa no topo
    const margemTopo = pessoaH * 0.10;
    const recorteY1 = Math.max(0, minY - margemTopo);
    const recorteY2 = Math.min(imgH, minY + pessoaH * 0.50);
    const recorteH = recorteY2 - recorteY1;
    const recorteW = Math.min(pessoaW * 1.2, imgW);
    const recorteX1 = Math.max(0, Math.round(rostoCentroX - recorteW / 2));

    const bustoBuffer = await sharp(semFundoBuffer)
      .extract({
        left: Math.round(recorteX1),
        top: Math.round(recorteY1),
        width: Math.round(recorteW),
        height: Math.round(recorteH),
      })
      .png()
      .toBuffer();

    // Escalar para caber bem na figurinha
    const areaDisponivel = COLARINHO_Y + 250;
    const areaW = 750;
    const scaleFinal = Math.min(areaW / recorteW, areaDisponivel / recorteH);
    const finalW = Math.round(recorteW * scaleFinal);
    const finalH = Math.round(recorteH * scaleFinal);

    const bustoResized = await sharp(bustoBuffer)
      .resize(finalW, finalH, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    // Posicionar: centralizado, topo a partir de 30px do início
    const fotoLeft = Math.round((CANVAS_W - finalW) / 2);
    const fotoTop = Math.max(30, COLARINHO_Y - finalH + 250);

    console.log(`   Posicao: left=${fotoLeft}, top=${fotoTop}, w=${finalW}, h=${finalH}`);

    console.log("4. Baixando fundo e camisa...");
    const [fundoBuffer, camisaBuffer] = await Promise.all([
      fetch(FUNDO_URL).then(r => r.buffer()),
      fetch(CAMISA_URL).then(r => r.buffer()),
    ]);

    console.log("5. Montando figurinha...");

    const nomeTexto = escaparXml(String(nome || "").toUpperCase());
    const timeTexto = escaparXml(String(time || "").toUpperCase());
    const dataTexto = escaparXml(String(dataNascimento || ""));
    const alturaTexto = escaparXml(String(altura || ""));
    const pesoTexto = escaparXml(String(peso || ""));

    console.log("Textos SVG:", { nomeTexto, timeTexto, dataTexto });

    const svgTexto = `<svg width="${CANVAS_W}" height="${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">
  <text x="514" y="1268" font-family="Arial Black, Arial" font-weight="900" font-size="50" fill="white" text-anchor="middle">${nomeTexto}</text>
  <text x="514" y="1318" font-family="Arial, sans-serif" font-size="30" fill="white" text-anchor="middle">${dataTexto} | ${alturaTexto} | ${pesoTexto}</text>
  <text x="340" y="1372" font-family="Arial Black, Arial" font-weight="900" font-size="30" fill="white" text-anchor="middle">${timeTexto}</text>
</svg>`;

    const figurinha = await sharp(fundoBuffer)
      .resize(CANVAS_W, CANVAS_H)
      .composite([
        { input: bustoResized, left: fotoLeft, top: fotoTop },
        { input: camisaBuffer, left: 0, top: 0 },
        { input: Buffer.from(svgTexto), left: 0, top: 0 },
      ])
      .png()
      .toBuffer();

    console.log("6. Figurinha gerada:", figurinha.length, "bytes OK");
    res.json({ imagemBase64: figurinha.toString("base64"), tipo: "png" });

  } catch (err) {
    console.error("ERRO:", err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
