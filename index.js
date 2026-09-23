import express from "express";
import pg from "pg";
import twilio from "twilio";
import { Storage } from "@google-cloud/storage";
import crypto from "crypto";

const { Pool } = pg;

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());


// ----------------------------------------------------
// DATABASE CONNECTIONS
// ----------------------------------------------------

const commonDbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT || 5432),
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
};

const operationsDb = new Pool({
  ...commonDbConfig,
  database: "operations"
});

const warehouseDb = new Pool({
  ...commonDbConfig,
  database: "warehouse"
});

const storage = new Storage();

const mediaBucketName =
  process.env.OPERATIONS_MEDIA_BUCKET || "operations-media";

const mediaBucket = storage.bucket(mediaBucketName);

const twilioApiKeySid = process.env.TWILIO_API_KEY_SID;
const twilioApiKeySecret = process.env.TWILIO_API_KEY_SECRET;


// ----------------------------------------------------
// HELPERS
// ----------------------------------------------------

function extractWhRef(text) {
  if (!text) return null;

  // Accept:
  // WH-123
  // WH123
  // WH 123
  // wh-123

  const match = text.match(/\bWH[\s-]?(\d+)\b/i);

  if (!match) return null;

  return `WH-${match[1]}`;
}


function makeReply(text) {
  const response = new twilio.twiml.MessagingResponse();

  response.message(text);

  return response.toString();
}

function mediaIdFromUrl(url) {
  if (!url) return null;

  const parts = url.split("/");
  return parts[parts.length - 1] || null;
}


function extensionForMimeType(mimeType) {
  const extensions = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",

    "application/pdf": ".pdf",

    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",

    "video/mp4": ".mp4",

    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      ".docx",

    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      ".xlsx"
  };

  return extensions[mimeType] || "";
}

function isBareWhSelector(text) {

  if (!text) return false;

  const remainder = text
    .replace(/\bWH[\s-]?\d+\b/i, "")
    .replace(/[\s:;,.\-–—]+/g, "")
    .trim();

  return remainder.length === 0;
}

async function downloadTwilioMedia(mediaUrl) {
  const credentials = Buffer.from(
    `${twilioApiKeySid}:${twilioApiKeySecret}`
  ).toString("base64");

  // Retry because Twilio can deliver the webhook slightly
  // before the media resource is available.
  const delays = [0, 500, 1500, 3000];

  for (let attempt = 0; attempt < delays.length; attempt++) {

    if (delays[attempt] > 0) {
      await new Promise(resolve =>
        setTimeout(resolve, delays[attempt])
      );
    }

    const response = await fetch(mediaUrl, {
      headers: {
        Authorization: `Basic ${credentials}`
      }
    });

    if (response.ok) {
      return Buffer.from(
        await response.arrayBuffer()
      );
    }

    if (
      response.status === 404 &&
      attempt < delays.length - 1
    ) {
      console.warn(
        `Twilio media not ready. ` +
        `Retry ${attempt + 1}/${delays.length - 1}`
      );

      continue;
    }

    throw new Error(
      `Twilio media download failed: ` +
      `${response.status} ${response.statusText}`
    );
  }

  throw new Error(
    "Twilio media download failed after retries."
  );
}

async function storeMediaForMessage(messageId, reqBody) {

  const numMedia =
    Number(reqBody.NumMedia || 0);

  const stored = [];

  for (let i = 0; i < numMedia; i++) {

    const mediaUrl =
      reqBody[`MediaUrl${i}`];

    const mimeType =
      reqBody[`MediaContentType${i}`] ||
      "application/octet-stream";

    if (!mediaUrl) {
      continue;
    }

    const externalMediaId =
      mediaIdFromUrl(mediaUrl);

    // Has this Twilio media item already been stored?
    const existing =
      await operationsDb.query(
        `
          SELECT
              media_id,
              storage_path
          FROM comms.media
          WHERE message_id = $1
            AND external_media_id = $2
          LIMIT 1
        `,
        [
          messageId,
          externalMediaId
        ]
      );

    if (existing.rows[0]) {

      console.log(
        `Media already stored: ${externalMediaId}`
      );

      stored.push(existing.rows[0]);

      continue;
    }


    const mediaId =
      crypto.randomUUID();

    const now =
      new Date();

    const year =
      now.getUTCFullYear();

    const month =
      String(now.getUTCMonth() + 1)
        .padStart(2, "0");

    const extension =
      extensionForMimeType(mimeType);

    const storagePath =
      `whatsapp/${year}/${month}/${messageId}/${mediaId}${extension}`;


    console.log(
      `Downloading Twilio media: ${externalMediaId}`
    );

    const contents =
      await downloadTwilioMedia(mediaUrl);


    console.log(
      `Saving media to gs://${mediaBucketName}/${storagePath}`
    );

    await mediaBucket
      .file(storagePath)
      .save(contents, {
        resumable: false,
        contentType: mimeType,
        metadata: {
          contentType: mimeType,
          metadata: {
            source: "WHATSAPP",
            provider: "TWILIO",
            externalMediaId:
              externalMediaId || ""
          }
        }
      });


    const result =
      await operationsDb.query(
        `
          INSERT INTO comms.media
          (
              media_id,
              message_id,
              external_media_id,
              mime_type,
              storage_path
          )
          VALUES
          (
              $1,
              $2,
              $3,
              $4,
              $5
          )

          ON CONFLICT
              (message_id, external_media_id)
          DO NOTHING

          RETURNING
              media_id,
              storage_path
        `,
        [
          mediaId,
          messageId,
          externalMediaId,
          mimeType,
          storagePath
        ]
      );

    stored.push(
      result.rows[0] || {
        media_id: mediaId,
        storage_path: storagePath
      }
    );
  }

  return stored;
}

async function getAuthorisedWhatsappUser(waId) {

  const result = await operationsDb.query(
    `
      SELECT
          wa_id,
          phone_number,
          display_name,
          status
      FROM comms.whatsapp_user
      WHERE wa_id = $1
        AND status = 'ACTIVE'
      LIMIT 1
    `,
    [waId]
  );

  return result.rows[0] || null;
}


async function findWarehouseRef(whRef) {

  const result = await warehouseDb.query(
    `
      SELECT
          wh_id,
          wh_ref
      FROM public.v_wh_detail
      WHERE upper(wh_ref) = upper($1)
      LIMIT 1
    `,
    [whRef]
  );

  return result.rows[0] || null;
}


async function setWhatsappSession(waId, whRef) {

  const result = await operationsDb.query(
    `
      INSERT INTO comms.session
      (
          source_type,
          source_user_id,
          entity_type,
          entity_ref,
          expires_ts
      )
      VALUES
      (
          'WHATSAPP',
          $1,
          'WH',
          $2,
          now() + interval '30 minutes'
      )

      ON CONFLICT (source_type, source_user_id)

      DO UPDATE SET
          entity_type      = 'WH',
          entity_ref       = EXCLUDED.entity_ref,
          last_activity_ts = now(),
          expires_ts       = now() + interval '30 minutes'

      RETURNING
          session_id,
          entity_type,
          entity_ref,
          expires_ts
    `,
    [waId, whRef]
  );

  return result.rows[0];
}


async function getActiveWhatsappSession(waId) {

  const result = await operationsDb.query(
    `
      SELECT
          session_id,
          entity_type,
          entity_ref,
          expires_ts
      FROM comms.session
      WHERE source_type = 'WHATSAPP'
        AND source_user_id = $1
        AND expires_ts > now()
      LIMIT 1
    `,
    [waId]
  );

  return result.rows[0] || null;
}
async function storeMessage({
  sourceType,
  provider,
  externalMessageId,
  sourceUserId,
  sourceDisplayName,
  messageType,
  messageText,
  isForwarded,
  rawPayload
}) {
  const result = await operationsDb.query(
    `
      INSERT INTO comms.message
      (
        source_type,
        provider,
        external_message_id,
        source_user_id,
        source_display_name,
        message_type,
        message_text,
        is_forwarded,
        raw_payload
      )
      VALUES
      (
        $1,$2,$3,$4,$5,$6,$7,$8,$9
      )
      ON CONFLICT (source_type, provider, external_message_id)
      DO UPDATE SET
        message_text        = EXCLUDED.message_text,
        source_display_name = EXCLUDED.source_display_name,
        is_forwarded        = EXCLUDED.is_forwarded,
        raw_payload         = EXCLUDED.raw_payload
      RETURNING message_id
    `,
    [
      sourceType,
      provider,
      externalMessageId,
      sourceUserId,
      sourceDisplayName,
      messageType,
      messageText || null,
      isForwarded,
      rawPayload
    ]
  );

  return result.rows[0].message_id;
}


async function linkMessageToEntity(messageId, entityType, entityRef, linkedBy) {
  await operationsDb.query(
    `
      INSERT INTO comms.message_link
      (
        message_id,
        entity_type,
        entity_ref,
        linked_by
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (message_id, entity_type, entity_ref)
      DO NOTHING
    `,
    [
      messageId,
      entityType,
      entityRef,
      linkedBy
    ]
  );
}

// ----------------------------------------------------
// HEALTH CHECK
// ----------------------------------------------------

app.get("/", (req, res) => {
  res.status(200).send("US OpsBot WhatsApp intake running");
});


// ----------------------------------------------------
// WHATSAPP WEBHOOK
// ----------------------------------------------------

app.post("/webhooks/whatsapp", async (req, res) => {

  console.log("=== US OpsBot WhatsApp webhook ===");
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

  try {

    // ------------------------------------------------
    // 1. WHITELIST
    // ------------------------------------------------

    const user = await getAuthorisedWhatsappUser(WaId);

    if (!user) {

      console.warn(
        `Rejected unauthorised WhatsApp user: ${WaId}`
      );

      const reply = makeReply(
        "This WhatsApp number is not authorised to use US OpsBot."
      );

      return res
        .status(200)
        .type("text/xml")
        .send(reply);
    }


    console.log(
      `Authorised user: ${user.display_name || WaId}`
    );


    // ------------------------------------------------
    // 2. LOOK FOR EXPLICIT WH REFERENCE
    // ------------------------------------------------

    const whRef = extractWhRef(Body);

    if (whRef) {

      console.log(`WH reference detected: ${whRef}`);

      // ----------------------------------------------
      // 3. VALIDATE AGAINST WAREHOUSE DATABASE
      // ----------------------------------------------

      const warehouse = await findWarehouseRef(whRef);

      if (!warehouse) {

        console.log(`WH not found: ${whRef}`);

        const reply = makeReply(
          `I can't find ${whRef}. Please check the WH reference and try again.`
        );

        return res
          .status(200)
          .type("text/xml")
          .send(reply);
      }


      // ----------------------------------------------
      // 4. CREATE / UPDATE SESSION
      // ----------------------------------------------

      const session = await setWhatsappSession(
        WaId,
        whRef
      );

      console.log(
        `Session set: ${session.entity_ref}`,
        session
      );
      const hasMedia =
  Number(NumMedia || 0) > 0;

const hasOperationalContent =
  hasMedia || !isBareWhSelector(Body);


// Bare "WH-123" is only a selector.
if (!hasOperationalContent) {

  const reply = makeReply(
    `${whRef} selected. Send or forward messages, photos or documents for this consignment.`
  );

  return res
    .status(200)
    .type("text/xml")
    .send(reply);
}


// WH reference plus text/media:
// select the WH AND save the content.

const messageId = await storeMessage({
  sourceType: "WHATSAPP",
  provider: "TWILIO",
  externalMessageId: MessageSid,
  sourceUserId: WaId,
  sourceDisplayName: ProfileName,
  messageType: MessageType,
  messageText: Body,
  isForwarded:
    Forwarded === "true"
      ? true
      : Forwarded === "false"
      ? false
      : null,
  rawPayload: req.body
});

await linkMessageToEntity(
  messageId,
  "WH",
  whRef,
  WaId
);

const storedMedia =
  await storeMediaForMessage(
    messageId,
    req.body
  );

let acknowledgement;

if (storedMedia.length > 0) {
  acknowledgement =
    `${whRef}: ${storedMedia.length} media item` +
    `${storedMedia.length === 1 ? "" : "s"} saved.`;
} else {
  acknowledgement =
    `${whRef}: message saved.`;
}

console.log(
  `Saved to ${activeSession.entity_ref}:`,
  {
    messageId,
    mediaCount: storedMedia.length,
    messageType: MessageType
  }
);

// No WhatsApp acknowledgement for ordinary content.
// Returning empty TwiML prevents OpsBot flooding the chat
// when several forwarded images arrive separately.

return res
  .status(200)
  .type("text/xml")
  .send(
    new twilio.twiml.MessagingResponse()
      .toString()
  );


    // ------------------------------------------------
    // 5. NO WH IN MESSAGE - CHECK EXISTING SESSION
    // ------------------------------------------------

    const activeSession =
      await getActiveWhatsappSession(WaId);


    if (activeSession) {

  const messageId = await storeMessage({
    sourceType: "WHATSAPP",
    provider: "TWILIO",
    externalMessageId: MessageSid,
    sourceUserId: WaId,
    sourceDisplayName: ProfileName,
    messageType: MessageType,
    messageText: Body,
    isForwarded:
      Forwarded === "true"
        ? true
        : Forwarded === "false"
        ? false
        : null,
    rawPayload: req.body
  });

  await linkMessageToEntity(
    messageId,
    activeSession.entity_type,
    activeSession.entity_ref,
    WaId
  );
  const storedMedia =
  await storeMediaForMessage(
    messageId,
    req.body
  );

  await operationsDb.query(
    `
      UPDATE comms.session
      SET
        last_activity_ts = now(),
        expires_ts = now() + interval '30 minutes'
      WHERE session_id = $1
    `,
    [activeSession.session_id]
  );

 let acknowledgement =
  `${activeSession.entity_ref}: message saved.`;

if (storedMedia.length > 0) {
  acknowledgement =
    `${activeSession.entity_ref}: ` +
    `${storedMedia.length} media item` +
    `${storedMedia.length === 1 ? "" : "s"} saved.`;
}

const reply =
  makeReply(acknowledgement);

  return res
    .status(200)
    .type("text/xml")
    .send(reply);
}


    // ------------------------------------------------
    // 6. NO WH AND NO ACTIVE SESSION
    // ------------------------------------------------

    const reply = makeReply(
      "Please send a WH reference first, for example WH-123."
    );

    return res
      .status(200)
      .type("text/xml")
      .send(reply);


  } catch (error) {

    console.error(
      "US OpsBot webhook error:",
      error
    );

    /*
      We deliberately return 200 to Twilio here so that
      a DB/configuration fault does not generate repeated
      webhook retries while we're testing.
    */

    const reply = makeReply(
      "Sorry, US OpsBot couldn't process that message. Please try again."
    );

    return res
      .status(200)
      .type("text/xml")
      .send(reply);
  }
});


const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`US OpsBot listening on port ${port}`);
});
