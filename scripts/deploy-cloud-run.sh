#!/bin/bash

# ============================================================================
# Script de Deploy a Google Cloud Run
#
# Uso: bash scripts/deploy-cloud-run.sh
# ============================================================================

set -e

echo "🚀 Desplegando Gift Cards API a Google Cloud Run"
echo ""

# Obtener variables
PROJECT_ID=$(gcloud config get-value project)
SERVICE_NAME="gift-cards-api"
REGION="us-central1"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}:latest"

echo "📋 Configuración:"
echo "   Proyecto: $PROJECT_ID"
echo "   Servicio: $SERVICE_NAME"
echo "   Región: $REGION"
echo "   Imagen: $IMAGE_NAME"
echo ""

# PASO 1: Build imagen Docker
echo "1️⃣  Compilando imagen Docker..."
gcloud builds submit --tag="$IMAGE_NAME" --project="$PROJECT_ID"
echo "   ✅ Imagen compilada"

# PASO 2: Deploy a Cloud Run
echo ""
echo "2️⃣  Desplegando a Cloud Run..."

gcloud run deploy "$SERVICE_NAME" \
  --image="$IMAGE_NAME" \
  --platform="managed" \
  --region="$REGION" \
  --allow-unauthenticated \
  --set-env-vars="NODE_ENV=production,LOG_LEVEL=info" \
  --memory="1Gi" \
  --cpu="1" \
  --timeout="600s" \
  --max-instances="10" \
  --min-instances="1" \
  --project="$PROJECT_ID"

echo "   ✅ Deployed"

# PASO 3: Obtener URL
echo ""
echo "3️⃣  Obteniendo URL de servicio..."

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --format='value(status.url)' \
  --project="$PROJECT_ID")

echo "   ✅ URL: $SERVICE_URL"

# PASO 4: Verificar health check
echo ""
echo "4️⃣  Verificando health check..."

sleep 5
HEALTH=$(curl -s "${SERVICE_URL}/health" || echo '{"error": "timeout"}')
echo "   📊 Respuesta: $HEALTH"

# PASO 5: Configurar variables de entorno en Secret Manager
echo ""
echo "5️⃣  Recordatorio: Configurar variables en Secret Manager"
echo "   Crear secrets para:"
echo "   - DATABASE_URL"
echo "   - AMAZON_PARTNER_ID"
echo "   - AMAZON_ACCESS_KEY"
echo "   - AMAZON_SECRET_KEY"
echo "   - SENDGRID_API_KEY"
echo "   - API_KEY"
echo "   - ENCRYPTION_KEY"
echo ""
echo "   Comando: gcloud secrets create NOMBRE --data-file=- < <(echo 'valor')"

echo ""
echo "✅ Deploy completado!"
echo ""
echo "Próximos pasos:"
echo "1. Actualizar SECRET MANAGER en Google Cloud Console"
echo "2. Actualizar Cloud Scheduler con URL real: $SERVICE_URL"
echo "3. Ejecutar: bash scripts/cloud-scheduler-setup.sh"
echo "4. Ver logs: gcloud logging read --limit 50"
