import express from "express";
import twilio from "twilio";

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

const client = twilio(accountSid, authToken);

app.get("/", (req, res) => {
  res.status(200).send("WhatsApp intake running");
});

function extractWhRef(text) {
  if (!text) return null;

  const match = text.match(/\bWH[\s-]?(\d+)\b/i);

  if (!match) return null;

  return `WH-${match[1]}`;
}

app.post("/webhooks/whatsapp", async (req, res) => {
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

  try {
    const outbound = await client.messages.create({
      from: To,
      to: From,
      body: reply
    });

    console.log("Outbound WhatsApp sent:", {
      sid: outbound.sid,
      status: outbound.status,
      from: To,
      to: From
    });
  } catch (err) {
    console.error("Outbound WhatsApp failed:", {
      message: err.message,
      code: err.code,
      status: err.status
    });
  }

  // We've handled the reply ourselves, so just acknowledge Twilio.
  res.status(200).send("OK");
});

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});