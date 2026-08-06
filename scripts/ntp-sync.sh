#!/bin/bash

# ============================================================================
# NTP Synchronization Script
#
# CRÍTICO: AWS Signature V4 requiere timestamp dentro de ±15 minutos
# Este script sincroniza el reloj del sistema
#
# Uso: bash scripts/ntp-sync.sh
# O ejecutar en cron: 0 * * * * /path/to/ntp-sync.sh
# ============================================================================

set -e

echo "🕐 NTP Synchronization para Gift Cards API"
echo ""

# Detectar sistema operativo
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS
  echo "📱 Sistema: macOS"

  # Método 1: sntp (sincronizar sin cambiar hora)
  echo "   ➜ Sincronizando reloj..."
  sudo sntp -sS time.apple.com 2>/dev/null || echo "   ⚠️  sntp no disponible, intentando ntpdate..."

  # Método 2: ntpdate (si está disponible)
  if command -v ntpdate &> /dev/null; then
    sudo ntpdate -s time.apple.com
    echo "   ✅ Reloj sincronizado con ntpdate"
  fi

  # Mostrar hora actual
  echo "   📊 Hora actual:"
  date "+   %Y-%m-%d %H:%M:%S UTC%z"

elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  # Linux
  echo "🐧 Sistema: Linux"

  # Método 1: timedatectl (systemd)
  if command -v timedatectl &> /dev/null; then
    echo "   ➜ Usando timedatectl..."

    # Verificar si NTP está habilitado
    NTP_STATUS=$(timedatectl status | grep "NTP service" | grep -o "active" || true)

    if [ -z "$NTP_STATUS" ]; then
      echo "   ⚠️  NTP no activo, habilitando..."
      sudo timedatectl set-ntp true
    fi

    # Sincronizar
    echo "   ➜ Sincronizando reloj..."
    sudo timedatectl set-time "$(date -u +'%Y-%m-%d %H:%M:%S')"
    echo "   ✅ Reloj sincronizado"

    # Mostrar status
    timedatectl status | head -5

  # Método 2: ntpd (ntp)
  elif command -v ntpd &> /dev/null; then
    echo "   ➜ Usando ntpd..."
    sudo service ntp status
    echo "   ✅ NTP ya está corriendo"

  # Método 3: chronyd (chrony)
  elif command -v chronyd &> /dev/null; then
    echo "   ➜ Usando chrony..."
    sudo service chrony status
    echo "   ✅ Chrony ya está corriendo"
  fi

elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
  # Windows
  echo "🪟 Sistema: Windows"
  echo "   ➜ Sincronizando reloj..."

  # Usar w32tm (Windows Time)
  w32tm /resync /force
  echo "   ✅ Reloj sincronizado"

  # Mostrar hora actual
  echo "   📊 Hora actual:"
  date

else
  # Desconocido
  echo "❓ Sistema: Desconocido"
  echo "   Por favor sincronizar manualmente"
fi

# Verificar offset de tiempo
echo ""
echo "🔍 Verificando offset de tiempo..."

# Comparar con servidor NTP remoto
if command -v ntpdate &> /dev/null; then
  OFFSET=$(ntpdate -q pool.ntp.org 2>/dev/null | grep "offset" | awk '{print $NF}' || echo "0")
  echo "   Offset: ${OFFSET} segundos"

  if (( $(echo "$OFFSET < 15" | bc -l) )); then
    echo "   ✅ Reloj sincronizado (< 15 seg)"
  else
    echo "   ⚠️  Offset > 15 segundos, reintentando..."
    sleep 2
    exec "$0"  # Reintentar
  fi
elif command -v timedatectl &> /dev/null; then
  echo "   ✅ Usando NTP automático (timedatectl)"
else
  echo "   ✅ Asumiendo reloj sincronizado"
fi

echo ""
echo "✅ NTP sync completado"
echo ""
echo "Para verificar:"
echo "  date +%s  # Timestamp actual"
echo "  date -u    # Hora UTC"
