import express from "express";
import pg from "pg";
import twilio from "twilio";
import { Storage } from "@google-cloud/storage";
import crypto from "crypto";
import sharp from "sharp";

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



function extractFreedomJobRef(text) {
  if (!text) return null;

  // Freedom references are currently six digits, e.g. 861955.
  // WH references are handled before this function is consulted.
  const match = String(text).match(/\b(\d{6})\b/);
  return match ? match[1] : null;
}

function isBareFreedomJobSelector(text, jobRef) {
  if (!text || !jobRef) return false;

  const remainder = String(text)
    .replace(new RegExp(`\\b${jobRef}\\b`), "")
    .replace(/[\s:;,\.\-–—]+/g, "")
    .trim();

  return remainder.length === 0;
}

function freedomJobNoteText(text, jobRef) {
  if (!text) return "";

  return String(text)
    .replace(new RegExp(`\\b${jobRef}\\b`), "")
    .replace(/^[\s:;,\.\-–—]+/, "")
    .trim();
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

async function createWhatsappThumbnail({
  contents,
  mimeType,
  year,
  month,
  messageId,
  mediaId
}) {

  if (!mimeType?.startsWith("image/")) {
    return {
      thumbStoragePath: null,
      thumbStatus: "SKIPPED"
    };
  }

  const thumbStoragePath =
    `whatsapp/${year}/${month}/${messageId}/thumb/${mediaId}.jpg`;

  try {

    const thumbBuffer = await sharp(contents)
      .rotate()
      .resize({
        width: 400,
        withoutEnlargement: true
      })
      .jpeg({
        quality: 70
      })
      .toBuffer();

    await mediaBucket
      .file(thumbStoragePath)
      .save(thumbBuffer, {
        resumable: false,
        contentType: "image/jpeg",
        metadata: {
          contentType: "image/jpeg",
          metadata: {
            source: "WHATSAPP",
            derivative: "THUMBNAIL"
          }
        }
      });

    return {
      thumbStoragePath,
      thumbStatus: "READY"
    };

  } catch (err) {

    console.error(
      `WhatsApp thumbnail generation failed for ${mediaId}:`,
      err
    );

    return {
      thumbStoragePath: null,
      thumbStatus: "FAILED"
    };
  }
}

async function storeMediaForMessage(messageId, reqBody) {

  const numMedia = Number(reqBody.NumMedia || 0);
  const stored = [];

  for (let i = 0; i < numMedia; i++) {

    const mediaUrl = reqBody[`MediaUrl${i}`];
    const mimeType =
      reqBody[`MediaContentType${i}`] ||
      "application/octet-stream";

    if (!mediaUrl) continue;

    const externalMediaId = mediaIdFromUrl(mediaUrl);

    const existing = await operationsDb.query(
      `
        SELECT
            media_id,
            external_media_id,
            mime_type,
            storage_path,
            thumb_storage_path,
            thumb_status
        FROM comms.media
        WHERE message_id = $1
          AND external_media_id = $2
        LIMIT 1
      `,
      [messageId, externalMediaId]
    );

    if (existing.rows[0]) {
      console.log(`Media already stored: ${externalMediaId}`);

      const row = existing.rows[0];
      const [contents] = await mediaBucket.file(row.storage_path).download();
      const extension = extensionForMimeType(row.mime_type || mimeType);

      stored.push({
        ...row,
        byte_size: contents.length,
        content_sha256: crypto.createHash("sha256").update(contents).digest("hex"),
        original_filename: `whatsapp-${externalMediaId || row.media_id}${extension}`
      });
      continue;
    }

    const mediaId = crypto.randomUUID();
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const extension = extensionForMimeType(mimeType);
    const storagePath =
      `whatsapp/${year}/${month}/${messageId}/${mediaId}${extension}`;

    console.log(`Downloading Twilio media: ${externalMediaId}`);
    const contents = await downloadTwilioMedia(mediaUrl);

    console.log(`Saving media to gs://${mediaBucketName}/${storagePath}`);
    await mediaBucket.file(storagePath).save(contents, {
      resumable: false,
      contentType: mimeType,
      metadata: {
        contentType: mimeType,
        metadata: {
          source: "WHATSAPP",
          provider: "TWILIO",
          externalMediaId: externalMediaId || ""
        }
      }
    });

    const { thumbStoragePath, thumbStatus } =
      await createWhatsappThumbnail({
        contents,
        mimeType,
        year,
        month,
        messageId,
        mediaId
      });

    const result = await operationsDb.query(
      `
        INSERT INTO comms.media
        (
            media_id,
            message_id,
            external_media_id,
            mime_type,
            storage_path,
            thumb_storage_path,
            thumb_status,
            thumb_created_ts
        )
        VALUES
        (
            $1,$2,$3,$4,$5,$6,$7,
            CASE WHEN $7 = 'READY' THEN now() ELSE NULL END
        )
        ON CONFLICT (message_id, external_media_id)
        DO NOTHING
        RETURNING
            media_id,
            external_media_id,
            mime_type,
            storage_path,
            thumb_storage_path,
            thumb_status
      `,
      [
        mediaId,
        messageId,
        externalMediaId,
        mimeType,
        storagePath,
        thumbStoragePath,
        thumbStatus
      ]
    );

    const row = result.rows[0] || {
      media_id: mediaId,
      external_media_id: externalMediaId,
      mime_type: mimeType,
      storage_path: storagePath,
      thumb_storage_path: thumbStoragePath,
      thumb_status: thumbStatus
    };

    stored.push({
      ...row,
      byte_size: contents.length,
      content_sha256: crypto.createHash("sha256").update(contents).digest("hex"),
      original_filename: `whatsapp-${externalMediaId || mediaId}${extension}`
    });
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


async function setWhatsappEntitySession(waId, entityType, entityRef) {

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
          $2,
          $3,
          now() + interval '30 minutes'
      )
      ON CONFLICT (source_type, source_user_id)
      DO UPDATE SET
          entity_type      = EXCLUDED.entity_type,
          entity_ref       = EXCLUDED.entity_ref,
          last_activity_ts = now(),
          expires_ts       = now() + interval '30 minutes'
      RETURNING
          session_id,
          entity_type,
          entity_ref,
          expires_ts
    `,
    [waId, entityType, entityRef]
  );

  return result.rows[0];
}

async function setWhatsappSession(waId, whRef) {
  return setWhatsappEntitySession(waId, "WH", whRef);
}

async function findFreedomJob(jobRef) {
  const result = await operationsDb.query(
    `
      SELECT
          job_ref,
          account_name,
          vehicle_description,
          despatch_instructions,
          freedom_status,
          CASE
            WHEN NULLIF(btrim(driver_callsign), '') IS NOT NULL
              THEN driver_callsign
            WHEN NULLIF(btrim(agent_code), '') IS NOT NULL
              THEN agent_code
            ELSE NULL
          END AS allocation_code,
          CASE
            WHEN NULLIF(btrim(driver_callsign), '') IS NOT NULL
              THEN concat_ws(' ', driver_firstname, driver_lastname)
            WHEN NULLIF(btrim(agent_code), '') IS NOT NULL
              THEN agent_name
            ELSE NULL
          END AS allocation_name
      FROM public.freedom_jobs
      WHERE job_ref = $1
      LIMIT 1
    `,
    [jobRef]
  );

  return result.rows[0] || null;
}

async function saveFreedomJobWhatsapp({
  jobRef,
  messageSid,
  waId,
  profileName,
  noteText,
  rawBody,
  storedMedia
}) {
  const sender = profileName
    ? `${profileName} (${waId})`
    : waId;

  if (noteText) {
    await operationsDb.query(
      `
        INSERT INTO public.job_notes
        (
          job_ref,
          source,
          source_message_id,
          sender,
          note_text,
          raw_body,
          received_at
        )
        VALUES ($1, 'WHATSAPP', $2, $3, $4, $5, now())
        ON CONFLICT DO NOTHING
      `,
      [jobRef, messageSid, sender, noteText, rawBody || noteText]
    );
  }

  for (const media of storedMedia || []) {
    await operationsDb.query(
      `
        INSERT INTO public.job_media
        (
          job_ref,
          source,
          source_message_id,
          source_media_id,
          sender,
          original_filename,
          content_type,
          byte_size,
          content_sha256,
          storage_bucket,
          storage_object,
          received_at
        )
        VALUES
        ($1, 'WHATSAPP', $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
        ON CONFLICT DO NOTHING
      `,
      [
        jobRef,
        messageSid,
        media.external_media_id || media.media_id,
        sender,
        media.original_filename || `whatsapp-${media.media_id}`,
        media.mime_type || "application/octet-stream",
        media.byte_size || null,
        media.content_sha256,
        mediaBucketName,
        media.storage_path
      ]
    );
  }
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

async function linkRecentPendingMessages(waId, entityType, entityRef, linkedBy) {
  const result = await operationsDb.query(
    `
      INSERT INTO comms.message_link
      (
        message_id,
        entity_type,
        entity_ref,
        linked_by
      )
      SELECT
        m.message_id,
        $2,
        $3,
        $4
      FROM comms.message m
      WHERE m.source_type = 'WHATSAPP'
        AND m.source_user_id = $1
        AND m.is_forwarded = true
        AND m.received_ts >= now() - interval '15 seconds'
        AND NOT EXISTS (
          SELECT 1
          FROM comms.message_link ml
          WHERE ml.message_id = m.message_id
        )
      ON CONFLICT (message_id, entity_type, entity_ref)
      DO NOTHING
      RETURNING message_id
    `,
    [waId, entityType, entityRef, linkedBy]
  );

  return result.rowCount;
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
    Body,
    NumMedia,
    ProfileName,
    WaId,
    MessageType,
    Forwarded
  } = req.body;

  try {
    // 1. WHITELIST
    const user = await getAuthorisedWhatsappUser(WaId);

    if (!user) {
      console.warn(`Rejected unauthorised WhatsApp user: ${WaId}`);
      return res.status(200).type("text/xml").send(
        makeReply("This WhatsApp number is not authorised to use US OpsBot.")
      );
    }

    console.log(`Authorised user: ${user.display_name || WaId}`);

    // 2. EXPLICIT WH REFERENCE KEEPS EXISTING WAREHOUSE BEHAVIOUR
    const whRef = extractWhRef(Body);

    if (whRef) {
      console.log(`WH reference detected: ${whRef}`);

      const warehouse = await findWarehouseRef(whRef);
      if (!warehouse) {
        return res.status(200).type("text/xml").send(
          makeReply(`I can't find ${whRef}. Please check the WH reference and try again.`)
        );
      }

      const session = await setWhatsappEntitySession(WaId, "WH", whRef);
      console.log(`Session set: ${session.entity_ref}`, session);

      const recoveredPending = await linkRecentPendingMessages(
        WaId, "WH", whRef, WaId
      );

      const hasMedia = Number(NumMedia || 0) > 0;
      const hasOperationalContent = hasMedia || !isBareWhSelector(Body);

      if (!hasOperationalContent) {
        let selectionText =
          `${whRef} selected. Send or forward messages, photos or documents for this consignment.`;
        if (recoveredPending > 0) {
          selectionText =
            `${whRef} selected. ${recoveredPending} earlier forwarded item` +
            `${recoveredPending === 1 ? " was" : "s were"} also linked.`;
        }
        return res.status(200).type("text/xml").send(makeReply(selectionText));
      }

      const messageId = await storeMessage({
        sourceType: "WHATSAPP",
        provider: "TWILIO",
        externalMessageId: MessageSid,
        sourceUserId: WaId,
        sourceDisplayName: ProfileName,
        messageType: MessageType,
        messageText: Body,
        isForwarded:
          Forwarded === "true" ? true :
          Forwarded === "false" ? false : null,
        rawPayload: req.body
      });

      await linkMessageToEntity(messageId, "WH", whRef, WaId);
      const storedMedia = await storeMediaForMessage(messageId, req.body);

      const acknowledgement = storedMedia.length > 0
        ? `${whRef}: ${storedMedia.length} media item${storedMedia.length === 1 ? "" : "s"} saved.`
        : `${whRef}: message saved.`;

      return res.status(200).type("text/xml").send(makeReply(acknowledgement));
    }

    // 3. EXPLICIT FREEDOM JOB REFERENCE
    const jobRef = extractFreedomJobRef(Body);

    if (jobRef) {
      console.log(`Freedom job reference detected: ${jobRef}`);

      const job = await findFreedomJob(jobRef);
      if (!job) {
        return res.status(200).type("text/xml").send(
          makeReply(`I can't find Freedom job ${jobRef}. Please check the job number and try again.`)
        );
      }

      const session = await setWhatsappEntitySession(WaId, "JOB", jobRef);
      console.log(`Job session set: ${session.entity_ref}`, session);

      const hasMedia = Number(NumMedia || 0) > 0;
      const noteText = freedomJobNoteText(Body, jobRef);
      const bareSelector = isBareFreedomJobSelector(Body, jobRef) && !hasMedia;

      if (bareSelector) {
        const allocation = [job.allocation_code, job.allocation_name]
          .filter(Boolean)
          .join(" · ");
        const label = job.account_name === "Internal Tracking - Warehouse Account"
          ? "Warehouse Task"
          : "Freedom Job";

        const lines = [
          `${label} ${jobRef} selected.`,
          allocation || "Unallocated",
          job.despatch_instructions || job.vehicle_description || ""
        ].filter(Boolean);

        lines.push("Send or forward messages, photos or documents for this job.");
        return res.status(200).type("text/xml").send(makeReply(lines.join("\n")));
      }

      const messageId = await storeMessage({
        sourceType: "WHATSAPP",
        provider: "TWILIO",
        externalMessageId: MessageSid,
        sourceUserId: WaId,
        sourceDisplayName: ProfileName,
        messageType: MessageType,
        messageText: Body,
        isForwarded:
          Forwarded === "true" ? true :
          Forwarded === "false" ? false : null,
        rawPayload: req.body
      });

      await linkMessageToEntity(messageId, "JOB", jobRef, WaId);
      const storedMedia = await storeMediaForMessage(messageId, req.body);

      await saveFreedomJobWhatsapp({
        jobRef,
        messageSid: MessageSid,
        waId: WaId,
        profileName: ProfileName,
        noteText,
        rawBody: Body,
        storedMedia
      });

      const acknowledgement = storedMedia.length > 0
        ? `Job ${jobRef}: ${storedMedia.length} media item${storedMedia.length === 1 ? "" : "s"} saved.`
        : `Job ${jobRef}: message saved.`;

      return res.status(200).type("text/xml").send(makeReply(acknowledgement));
    }

    // 4. NO EXPLICIT REFERENCE - USE ACTIVE SESSION
    const activeSession = await getActiveWhatsappSession(WaId);

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
          Forwarded === "true" ? true :
          Forwarded === "false" ? false : null,
        rawPayload: req.body
      });

      await linkMessageToEntity(
        messageId,
        activeSession.entity_type,
        activeSession.entity_ref,
        WaId
      );

      const storedMedia = await storeMediaForMessage(messageId, req.body);

      if (activeSession.entity_type === "JOB") {
        await saveFreedomJobWhatsapp({
          jobRef: activeSession.entity_ref,
          messageSid: MessageSid,
          waId: WaId,
          profileName: ProfileName,
          noteText: String(Body || "").trim(),
          rawBody: Body,
          storedMedia
        });
      }

      await operationsDb.query(
        `
          UPDATE comms.session
          SET last_activity_ts = now(),
              expires_ts = now() + interval '30 minutes'
          WHERE session_id = $1
        `,
        [activeSession.session_id]
      );

      // Keep ordinary follow-up content quiet to avoid chat spam.
      return res.status(200).type("text/xml").send(
        new twilio.twiml.MessagingResponse().toString()
      );
    }

    // 5. NO REFERENCE AND NO SESSION
    const isForwarded = Forwarded === "true";

    if (isForwarded) {
      const messageId = await storeMessage({
        sourceType: "WHATSAPP",
        provider: "TWILIO",
        externalMessageId: MessageSid,
        sourceUserId: WaId,
        sourceDisplayName: ProfileName,
        messageType: MessageType,
        messageText: Body,
        isForwarded: true,
        rawPayload: req.body
      });

      await storeMediaForMessage(messageId, req.body);

      return res.status(200).type("text/xml").send(
        makeReply("Received. Send either the WH reference (for example WH-123) or the Freedom job number (for example 861955).")
      );
    }

    return res.status(200).type("text/xml").send(
      makeReply("Send either a WH reference (for example WH-123) or a Freedom job number (for example 861955).")
    );

  } catch (error) {
    console.error("US OpsBot webhook error:", error);

    return res.status(200).type("text/xml").send(
      makeReply("Sorry, US OpsBot couldn't process that message. Please try again.")
    );
  }
});


const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`US OpsBot listening on port ${port}`);
});
