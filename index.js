import express from "express";
import twilio from "twilio";

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

function extractWhRef(text) {
  if (!text) return null;

  const match = text.match(/\bWH[\s-]?(\d+)\b/i);

  if (!match) return null;

  return `WH-${match[1]}`;
}

app.post("/webhooks/whatsapp", (req, res) => {
  console.log("=== WhatsApp webhook received ===");
  console.log(JSON.stringify(req.body, null, 2));

  const whRef = extractWhRef(req.body.Body);

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

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  const xml = twiml.toString();

  console.log("Bot reply:", reply);
  console.log("TwiML response:", xml);

  res
    .status(200)
    .type("text/xml")
    .send(xml);
});

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
