import pg from "pg";
import { Storage } from "@google-cloud/storage";
import sharp from "sharp";

const { Pool } = pg;

const operationsDb = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT || 5432),
  database: "operations",
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const storage = new Storage();

const mediaBucketName =
  process.env.OPERATIONS_MEDIA_BUCKET || "operations-media";

const mediaBucket =
  storage.bucket(mediaBucketName);


function buildThumbnailPath(row) {

  /*
    Existing original:

    whatsapp/2026/09/<messageId>/<mediaId>.jpg

    New thumbnail:

    whatsapp/2026/09/<messageId>/thumb/<mediaId>.jpg
  */

  const parts =
    row.storage_path.split("/");

  const filename =
    parts.pop();

  const directory =
    parts.join("/");

  const baseName =
    filename.replace(/\.[^.]+$/, "");

  return `${directory}/thumb/${baseName}.jpg`;
}


async function main() {

  const result =
    await operationsDb.query(
      `
        SELECT
            media_id,
            message_id,
            mime_type,
            storage_path
        FROM comms.media
        WHERE mime_type LIKE 'image/%'
          AND thumb_status = 'PENDING'
          AND is_enabled = true
        ORDER BY media_id
      `
    );

  console.log(
    `Found ${result.rowCount} image(s) requiring thumbnails.`
  );


  for (const row of result.rows) {

    const thumbStoragePath =
      buildThumbnailPath(row);

    try {

      console.log(
        `Processing ${row.media_id}`
      );

      const [contents] =
        await mediaBucket
          .file(row.storage_path)
          .download();

      const thumbBuffer =
        await sharp(contents)
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


      await operationsDb.query(
        `
          UPDATE comms.media
          SET
              thumb_storage_path = $2,
              thumb_status = 'READY',
              thumb_created_ts = now()
          WHERE media_id = $1
        `,
        [
          row.media_id,
          thumbStoragePath
        ]
      );

      console.log(
        `READY: ${row.media_id}`
      );

    } catch (err) {

      console.error(
        `FAILED: ${row.media_id}`,
        err.message
      );

      await operationsDb.query(
        `
          UPDATE comms.media
          SET
              thumb_storage_path = NULL,
              thumb_status = 'FAILED',
              thumb_created_ts = NULL
          WHERE media_id = $1
        `,
        [row.media_id]
      );
    }
  }


  const summary =
    await operationsDb.query(
      `
        SELECT
            thumb_status,
            count(*) AS media_count
        FROM comms.media
        GROUP BY thumb_status
        ORDER BY thumb_status
      `
    );

  console.table(summary.rows);

  await operationsDb.end();
}


main()
  .then(() => {
    console.log("Thumbnail backfill complete.");
    process.exit(0);
  })
  .catch(async err => {

    console.error(
      "Thumbnail backfill failed:",
      err
    );

    await operationsDb.end();

    process.exit(1);
  });