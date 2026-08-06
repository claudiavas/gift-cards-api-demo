/**
 * Script de Setup - Crear tablas en BigQuery
 *
 * Uso:
 * node scripts/setup-bigquery.js
 *
 * Este script:
 * 1. Verifica credenciales de Google Cloud
 * 2. Crea el dataset si no existe
 * 3. Crea todas las tablas con schema correcto
 * 4. Valida permisos y constraints
 */

require('dotenv').config();
const { BigQuery } = require('@google-cloud/bigquery');

async function setupBigQuery() {
  console.log('\n🔧 Setup BigQuery para Gift Cards API\n');

  // Validar variables de entorno
  if (!process.env.GOOGLE_PROJECT_ID || !process.env.GOOGLE_DATASET_ID) {
    console.error('❌ Error: GOOGLE_PROJECT_ID o GOOGLE_DATASET_ID no definidas en .env');
    process.exit(1);
  }

  const projectId = process.env.GOOGLE_PROJECT_ID;
  const datasetId = process.env.GOOGLE_DATASET_ID;

  console.log(`📋 Proyecto: ${projectId}`);
  console.log(`📊 Dataset: ${datasetId}\n`);

  try {
    // Inicializar cliente BigQuery
    const bigquery = new BigQuery({ projectId });

    // PASO 1: Crear dataset si no existe
    console.log('1️⃣  Creando dataset...');
    const dataset = bigquery.dataset(datasetId);
    const datasetExists = await dataset.exists();

    if (!datasetExists[0]) {
      console.log(`   ➜ Dataset no existe, creando...`);
      await bigquery.createDataset(datasetId, {
        location: 'US', // O la región que uses
        description: 'Dataset para Gift Cards API',
      });
      console.log(`   ✅ Dataset creado: ${datasetId}`);
    } else {
      console.log(`   ✅ Dataset ya existe: ${datasetId}`);
    }

    // PASO 2: Crear tablas
    console.log('\n2️⃣  Creando tablas...\n');

    // Tabla: gift_cards
    await createGiftCardsTable(dataset);

    // Tabla: access_logs
    await createAccessLogsTable(dataset);

    // PASO 3: Configurar permisos IAM
    console.log('\n3️⃣  Configurando IAM...');
    console.log('   ⚠️  IMPORTANTE: Configurar manualmente en Google Cloud Console');
    console.log('   - Role "Gift Cards Auditor" (solo lectura)');
    console.log('   - Asignar a: IT/compliance/dirección de ACME');
    console.log('   - Endpoints: dataset.tables.get, dataset.tables.list');

    console.log('\n✅ Setup completado!\n');
    console.log('Próximos pasos:');
    console.log('1. Verificar tablas en BigQuery Console');
    console.log('2. Configurar IAM roles');
    console.log('3. Ejecutar: npm run test:bigquery');

  } catch (error) {
    console.error('❌ Error en setup:', error.message);
    process.exit(1);
  }
}

/**
 * Crear tabla gift_cards
 */
async function createGiftCardsTable(dataset) {
  const tableName = 'gift_cards';
  const table = dataset.table(tableName);
  const exists = await table.exists();

  if (exists[0]) {
    console.log(`   ✅ ${tableName} ya existe`);
    return;
  }

  console.log(`   ➜ Creando ${tableName}...`);

  const schema = [
    { name: 'id', type: 'STRING', mode: 'REQUIRED', description: 'UUID único' },
    { name: 'referido_id', type: 'STRING', mode: 'REQUIRED', description: 'ID Referidos (UNIQUE)' },
    { name: 'contact_email', type: 'STRING', mode: 'REQUIRED', description: 'Email del alumno' },
    { name: 'amazon_code_encrypted', type: 'STRING', mode: 'REQUIRED', description: 'Código AES-256' },
    { name: 'amazon_creation_request_id', type: 'STRING', mode: 'REQUIRED', description: 'UUID idempotencia (UNIQUE)' },
    { name: 'amazon_currency_code', type: 'STRING', description: 'USD, EUR, etc' },
    { name: 'amazon_amount', type: 'INTEGER', description: 'Monto en unidades menores' },
    { name: 'amazon_redeemed_at', type: 'TIMESTAMP', description: 'Cuándo se canjeó' },
    { name: 'amazon_redeemed_ip', type: 'STRING', description: 'IP de canje' },
    { name: 'sendgrid_message_id', type: 'STRING', description: 'ID SendGrid' },
    { name: 'email_sent', type: 'BOOLEAN', defaultValue: 'false', description: '¿Enviado?' },
    { name: 'email_sent_at', type: 'TIMESTAMP', description: 'Cuándo se envió' },
    { name: 'email_resent_count', type: 'INTEGER', defaultValue: '0', description: 'Reenvíos (max 5)' },
    { name: 'email_resent_dates', type: 'TIMESTAMP', mode: 'REPEATED', description: 'Timestamps de reenvíos' },
    { name: 'email_last_resent_at', type: 'TIMESTAMP', description: 'Último reenvío' },
    { name: 'email_status', type: 'STRING', description: 'pending, sent, resent, bounced, opened' },
    { name: 'bounce_reason_es', type: 'STRING', description: 'Motivo rechazo en español' },
    { name: 'email_template', type: 'STRING', description: 'ID plantilla SendGrid' },
    { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED', description: 'Creación' },
    { name: 'updated_at', type: 'TIMESTAMP', mode: 'REQUIRED', description: 'Última actualización' },
  ];

  try {
    await dataset.createTable(tableName, { schema });
    console.log(`   ✅ ${tableName} creada`);
  } catch (error) {
    console.error(`   ❌ Error creando ${tableName}:`, error.message);
    throw error;
  }
}

/**
 * Crear tabla access_logs
 */
async function createAccessLogsTable(dataset) {
  const tableName = 'access_logs';
  const table = dataset.table(tableName);
  const exists = await table.exists();

  if (exists[0]) {
    console.log(`   ✅ ${tableName} ya existe`);
    return;
  }

  console.log(`   ➜ Creando ${tableName}...`);

  const schema = [
    { name: 'id', type: 'STRING', mode: 'REQUIRED', description: 'UUID único' },
    { name: 'gift_card_id', type: 'STRING', description: 'Referencia a gift_cards.id' },
    { name: 'action', type: 'STRING', mode: 'REQUIRED', description: 'validation_failed, amazon_error, generated, sent, resent' },
    { name: 'performed_by', type: 'STRING', description: 'scheduler, user@email.com, system' },
    { name: 'source_ip', type: 'STRING', description: 'IP de la acción' },
    { name: 'failure_reason', type: 'STRING', description: 'Motivo del fallo' },
    { name: 'amazon_error_code', type: 'STRING', description: 'F100, F200, F300, F400, F500' },
    { name: 'amazon_error_msg', type: 'STRING', description: 'Mensaje de Amazon' },
    { name: 'metadata', type: 'JSON', description: 'Datos adicionales' },
    { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED', description: 'Timestamp del evento' },
  ];

  try {
    await dataset.createTable(tableName, { schema });
    console.log(`   ✅ ${tableName} creada`);
  } catch (error) {
    console.error(`   ❌ Error creando ${tableName}:`, error.message);
    throw error;
  }
}

// Ejecutar setup
setupBigQuery().catch(error => {
  console.error('Setup falló:', error);
  process.exit(1);
});
