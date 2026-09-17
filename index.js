import express from "express";

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).send("WhatsApp intake running");
});

function extractWhRef(text) {
  if (!text) return null;

  // Accept examples such as:
  // WH-123
  // WH123
  // WH 123
  // wh-123
  const match = text.match(/\bWH[\s-]?(\d+)\b/i);

  if (!match) return null;

  return `WH-${match[1]}`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

app.post("/webhooks/whatsapp", (req, res) => {
  console.log("=== WhatsApp webhook received ===");
  console.log(JSON.stringify(req.body, null, 2));

  const {
    MessageSid,
    From,
    To,
    Body,
    NumMedia,
    ProfileName,
    WaId,
    MessageType,
    Forwarded,
    FrequentlyForwarded
  } = req.body;

  console.log({
    MessageSid,
    From,
    To,
    Body,
    NumMedia,
    ProfileName,
    WaId,
    MessageType,
    Forwarded,
    FrequentlyForwarded
  });

  const whRef = extractWhRef(Body);

  let reply;

  if (whRef) {
    reply =
      `${whRef} selected. ` +
      `Send or forward messages, photos or documents for this consignment.`;
  } else {
    reply =
      "I couldn't find a WH reference. " +
      "Please send one, for example WH-123.";
  }

  console.log("Bot reply:", reply);

  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Message>${escapeXml(reply)}</Message>` +
    `</Response>`;

  res.status(200).type("text/xml").send(twiml);
});

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
