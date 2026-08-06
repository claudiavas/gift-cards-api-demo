#!/bin/bash

# ============================================================================
# Script para configurar Cloud Scheduler
#
# Crea un job diario que llama al endpoint POST /gift-cards/process
# Busca referidos con 20+ días sin tarjeta regalo
#
# Uso: bash scripts/cloud-scheduler-setup.sh
# ============================================================================

set -e

echo "🔧 Configurando Google Cloud Scheduler para Gift Cards API"
echo ""

# Variables
PROJECT_ID=${1:-$(gcloud config get-value project)}
REGION="us-central1"  # Cambiar según tu región
API_ENDPOINT="https://gift-cards-api-[PROJECT].run.app"  # Reemplazar [PROJECT]
API_KEY=${2:-$(grep API_KEY .env | cut -d '=' -f2)}

# Validaciones
if [ -z "$PROJECT_ID" ]; then
  echo "❌ Error: No se pudo determinar PROJECT_ID"
  echo "Uso: bash scripts/cloud-scheduler-setup.sh <PROJECT_ID> [API_KEY]"
  exit 1
fi

echo "📋 Configuración:"
echo "   Proyecto: $PROJECT_ID"
echo "   Región: $REGION"
echo "   Endpoint: $API_ENDPOINT"
echo ""

# PASO 1: Crear service account si no existe
echo "1️⃣  Verificando service account..."
SERVICE_ACCOUNT="gift-cards-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT" --project="$PROJECT_ID" 2>/dev/null; then
  echo "   ➜ Creando service account..."
  gcloud iam service-accounts create gift-cards-scheduler \
    --display-name="Gift Cards API Scheduler" \
    --project="$PROJECT_ID"
  echo "   ✅ Service account creado"
else
  echo "   ✅ Service account ya existe"
fi

# PASO 2: Crear Cloud Scheduler job
echo ""
echo "2️⃣  Creando Cloud Scheduler job..."

# Payload para el POST
PAYLOAD='[
  {"referidoId": "{{referidoId}}", "contactId": "{{contactId}}"},
  {"referidoId": "{{referidoId2}}", "contactId": "{{contactId2}}"}
]'

# Crear job (reemplazar cada día con nuevos referidos)
gcloud scheduler jobs create http "gift-cards-daily" \
  --schedule="0 3 * * *" \  # 3 AM UTC cada día
  --time-zone="UTC" \
  --http-method="POST" \
  --uri="${API_ENDPOINT}/gift-cards/process" \
  --oidc-service-account-email="$SERVICE_ACCOUNT" \
  --oidc-token-audience="${API_ENDPOINT}" \
  --headers="x-api-key=${API_KEY},Content-Type=application/json" \
  --message-body='{"referidoId":"AUTO_FETCH","mode":"scheduled"}' \
  --project="$PROJECT_ID" \
  --location="$REGION" \
  --no-attempt-deadline || \
gcloud scheduler jobs update http "gift-cards-daily" \
  --schedule="0 3 * * *" \
  --time-zone="UTC" \
  --http-method="POST" \
  --uri="${API_ENDPOINT}/gift-cards/process" \
  --oidc-service-account-email="$SERVICE_ACCOUNT" \
  --oidc-token-audience="${API_ENDPOINT}" \
  --headers="x-api-key=${API_KEY},Content-Type=application/json" \
  --message-body='{"referidoId":"AUTO_FETCH","mode":"scheduled"}' \
  --project="$PROJECT_ID" \
  --location="$REGION" \
  --no-attempt-deadline

echo "   ✅ Job creado/actualizado: gift-cards-daily"

# PASO 3: Configurar permisos IAM
echo ""
echo "3️⃣  Configurando IAM..."

# Cloud Run: Cloud Scheduler puede invocar el endpoint
gcloud run services add-iam-policy-binding gift-cards-api \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/run.invoker" \
  --region="$REGION" \
  --project="$PROJECT_ID" 2>/dev/null || true

echo "   ✅ Permisos IAM configurados"

# PASO 4: Instrucciones finales
echo ""
echo "✅ Cloud Scheduler configurado!"
echo ""
echo "Próximos pasos:"
echo "1. Reemplazar API_ENDPOINT con URL real de Cloud Run"
echo "2. Verificar job: gcloud scheduler jobs describe gift-cards-daily --location=$REGION"
echo "3. Ejecutar manualmente: gcloud scheduler jobs run gift-cards-daily --location=$REGION"
echo "4. Ver logs: gcloud logging read --limit 50 | grep gift-cards"
echo ""
echo "Nota: El scheduler busca referidos automáticamente en cada ejecución"
echo "Se ejecuta diariamente a las 3 AM UTC"
