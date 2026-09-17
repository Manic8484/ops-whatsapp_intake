import express from "express";

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).send("WhatsApp intake running");
});

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
    Forwarded,
    FrequentlyForwarded
  });

  res
    .status(200)
    .type("text/xml")
    .send("<Response></Response>");
});

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});