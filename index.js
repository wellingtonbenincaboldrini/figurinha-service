const express = require("express");
const sharp = require("sharp");
const fetch = require("node-fetch");
const FormData = require("form-data");

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 3000;
const REMOVEBG_API_KEY = process.env.REMOVEBG_API_KEY;

const FUNDO_URL = "https://znnycpkxezeclssqvyhu.supabase.co/storage/v1/object/public/fotos-clientes/base%20sem%20camisa.png";
const CAMISA_URL = "https://znnycpkxezeclssqvyhu.supabase.co/storage/v1/object/public/fotos-clientes/camisa.png";

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/gerar-figurinha", async (req, res) => {
  try {
    const { fotoUrl, nome, dataNascimento, altura, peso, time } = req.body;
    if (!fotoUrl) return res.status(400).json({ erro: "fotoUrl obrigatório" });

    console.log("1. Baixando foto:", fotoUrl);
    const fotoRes = await fetch(fotoUrl);
    console.log("   Content-Type da foto:", fotoRes.headers.get("content-type"));
    const fotoBuffer = await fotoRes.buffer();
    console.log("   Tamanho foto:", fotoBuffer.length, "bytes");

    console.log("2. Removendo fundo via Remove.bg...");
    console.log("   API Key presente:", !!REMOVEBG_API_KEY, "tamanho:", REMOVEBG_API_KEY?.length);

    const form = new FormData();
    form.append("image_file", fotoBuffer, { filename: "foto.jpg", contentType: "image/jpeg" });
    form.append("size", "auto");

    const rbgRes = await fetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: { "X-Api-Key": REMOVEBG_API_KEY, ...form.getHeaders() },
      body: form,
    });

    console.log("   Remove.bg status:", rbgRes.status);
    console.log("   Remove.bg content-type:", rbgRes.headers.get("content-type"));

    if (!rbgRes.ok) {
      const err = await rbgRes.text();
      console.log("   Remove.bg erro body:", err);
      throw new Error("Remove.bg erro: " + err);
    }

    const semFundoBuffer = await rbgRes.buffer();
    console.log("   Remove.bg retornou:", semFundoBuffer.length, "bytes");
    console.log("   Primeiros 8 bytes (hex):", semFundoBuffer.slice(0, 8).toString("hex"));

    // Verificar se é PNG válido (PNG começa com 89504e47)
    const isPng = semFundoBuffer.slice(0, 4).toString("hex") === "89504e47";
    console.log("   É PNG válido:", isPng);

    if (!isPng) {
      // Tentar converter
      console.log("   Tentando converter para PNG...");
    }

    console.log("3. Processando com Sharp...");
    const semFundoPng = await sharp(semFundoBuffer).png().toBuffer();
    const semFundoMeta = await sharp(semFundoPng).metadata();
    console.log("   Dimensões:", semFundoMeta.width, "x", semFundoMeta.height);

    const areaH = 730;
    const areaW = 700;
    const scale = Math.min(areaW / semFundoMeta.width, areaH / semFundoMeta.height);
    const fotoW = Math.round(semFundoMeta.width * scale);
    const fotoH = Math.round(semFundoMeta.height * scale);

    const fotoResized = await sharp(semFundoPng)
      .resize(fotoW, fotoH, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    const fotoLeft = Math.round((1029 - fotoW) / 2);
    const fotoTop = Math.max(0, 611 - fotoH + 120);
    console.log("   Posição foto:", fotoLeft, fotoTop, fotoW, fotoH);

    console.log("4. Baixando fundo e camisa...");
    const [fundoBuffer, camisaBuffer] = await Promise.all([
      fetch(FUNDO_URL).then(r => r.buffer()),
      fetch(CAMISA_URL).then(r => r.buffer()),
    ]);
    console.log("   Fundo:", fundoBuffer.length, "bytes");
    console.log("   Camisa:", camisaBuffer.length, "bytes");

    console.log("5. Montando figurinha...");
    const svgTexto = `<svg width="1029" height="1528" xmlns="http://www.w3.org/2000/svg">
  <text x="514" y="1268" font-family="Arial Black, Arial" font-weight="900" font-size="50" fill="white" text-anchor="middle">${(nome || "").toUpperCase()}</text>
  <text x="514" y="1318" font-family="Arial, sans-serif" font-size="30" fill="white" text-anchor="middle">${dataNascimento || ""} | ${altura || ""} | ${peso || ""}</text>
  <text x="340" y="1372" font-family="Arial Black, Arial" font-weight="900" font-size="30" fill="white" text-anchor="middle">${(time || "").toUpperCase()}</text>
</svg>`;

    const svgBuffer = Buffer.from(svgTexto);

    const figurinha = await sharp(fundoBuffer)
      .resize(1029, 1528)
      .composite([
        { input: fotoResized, left: fotoLeft, top: fotoTop },
        { input: camisaBuffer, left: 0, top: 0 },
        { input: svgBuffer, left: 0, top: 0 },
      ])
      .png()
      .toBuffer();

    console.log("6. Figurinha gerada:", figurinha.length, "bytes");
    const base64 = figurinha.toString("base64");
    res.json({ imagemBase64: base64, tipo: "png" });

  } catch (err) {
    console.error("ERRO:", err.message);
    console.error("Stack:", err.stack);
    res.status(500).json({ erro: err.message });
  }
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
