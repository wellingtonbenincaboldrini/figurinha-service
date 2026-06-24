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

// Área disponível para a pessoa: topo 60px até 1100px
const PESSOA_TOPO = 60;
const PESSOA_BASE = 1100;
const PESSOA_AREA_H = PESSOA_BASE - PESSOA_TOPO; // 1040px
const PESSOA_AREA_W = 900;

function escaparXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function gerarTextoPng(texto, largura, altura, fontSize, bold, cor) {
  const svg = `<svg width="${largura}" height="${altura}" xmlns="http://www.w3.org/2000/svg">
    <text 
      x="${largura/2}" 
      y="${altura * 0.78}" 
      font-family="sans-serif"
      font-size="${fontSize}"
      font-weight="${bold ? 'bold' : 'normal'}"
      fill="${cor || 'white'}"
      text-anchor="middle"
    >${escaparXml(texto)}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
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

    console.log(`   Pessoa: w=${pessoaW}, h=${pessoaH}`);

    // Recortar pessoa inteira com margem no topo
    const margemTopo = pessoaH * 0.08;
    const recorteY1 = Math.max(0, minY - margemTopo);
    const recorteY2 = Math.min(imgH, maxY);
    const recorteH = recorteY2 - recorteY1;
    const recorteW = Math.min(pessoaW * 1.1, imgW);
    const recorteX1 = Math.max(0, Math.round(rostoCentroX - recorteW / 2));

    const pessoaRecortadaBuffer = await sharp(semFundoBuffer)
      .extract({
        left: Math.round(recorteX1),
        top: Math.round(recorteY1),
        width: Math.round(recorteW),
        height: Math.round(recorteH),
      })
      .png()
      .toBuffer();

    // Escalar para caber na área disponível mantendo proporção
    const scaleH = PESSOA_AREA_H / recorteH;
    const scaleW = PESSOA_AREA_W / recorteW;
    const scale = Math.min(scaleH, scaleW);
    const finalW = Math.round(recorteW * scale);
    const finalH = Math.round(recorteH * scale);

    console.log(`   Tamanho final: ${finalW}x${finalH}`);

    const pessoaResized = await sharp(pessoaRecortadaBuffer)
      .resize(finalW, finalH, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    // Centralizar horizontalmente, alinhar base em PESSOA_BASE
    const fotoLeft = Math.round((CANVAS_W - finalW) / 2);
    const fotoTop = PESSOA_BASE - finalH;

    console.log(`   Posicao: left=${fotoLeft}, top=${fotoTop}`);

    console.log("4. Baixando fundo e camisa...");
    const [fundoBuffer, camisaBuffer] = await Promise.all([
      fetch(FUNDO_URL).then(r => r.buffer()),
      fetch(CAMISA_URL).then(r => r.buffer()),
    ]);

    console.log("5. Gerando textos...");
    const nomeTxt = String(nome || "").toUpperCase();
    const timeTxt = String(time || "").toUpperCase();
    const dataTxt = `${dataNascimento || ""} | ${altura || ""} | ${peso || ""}`;

    const [nomePng, dataPng, timePng] = await Promise.all([
      gerarTextoPng(nomeTxt, 900, 70, 52, true, "white"),
      gerarTextoPng(dataTxt, 900, 50, 28, false, "white"),
      gerarTextoPng(timeTxt, 600, 50, 30, true, "white"),
    ]);

    console.log("6. Montando figurinha...");
    const figurinha = await sharp(fundoBuffer)
      .resize(CANVAS_W, CANVAS_H)
      .composite([
        { input: pessoaResized, left: fotoLeft, top: fotoTop },
        { input: camisaBuffer, left: 0, top: 0 },
        { input: nomePng,  left: Math.round((CANVAS_W - 900) / 2), top: 1190 },
        { input: dataPng,  left: Math.round((CANVAS_W - 900) / 2), top: 1255 },
        { input: timePng,  left: Math.round((CANVAS_W - 600) / 2) - 80, top: 1310 },
      ])
      .png()
      .toBuffer();

    console.log("7. Figurinha gerada:", figurinha.length, "bytes OK");
    res.json({ imagemBase64: figurinha.toString("base64"), tipo: "png" });

  } catch (err) {
    console.error("ERRO:", err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
