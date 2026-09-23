import express from "express";
import pg from "pg";
import twilio from "twilio";

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
      SELECT wh_id
      FROM public.v_wh_detail
      WHERE wh_id = $1
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


      const reply = makeReply(
        `${whRef} selected. Send or forward messages, photos or documents for this consignment.`
      );

      return res
        .status(200)
        .type("text/xml")
        .send(reply);
    }


    // ------------------------------------------------
    // 5. NO WH IN MESSAGE - CHECK EXISTING SESSION
    // ------------------------------------------------

    const activeSession =
      await getActiveWhatsappSession(WaId);


    if (activeSession) {

      console.log(
        `Active session: ${activeSession.entity_ref}`
      );

      /*
        We are NOT storing the incoming message yet.

        This branch simply proves that OpsBot remembers
        the selected WH between webhook calls.
      */

      const reply = makeReply(
        `${activeSession.entity_ref} is currently selected.`
      );

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
