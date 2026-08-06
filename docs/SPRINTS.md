# Zoho Sprints - Sistema Gift Cards (4 Semanas)

## Epic: Sistema Gift Cards - Integración Amazon + Custodia Segura

**Fechas:** 22 Mayo - 10 Junio 2026  
**Duración Total:** 4 semanas (20 días calendario = 14 días hábiles)  
**Equipo:** Developer (40h/semana)  
**Estado:** Backlog

---

## SEMANA 1: 22-23 Mayo (Jueves-Viernes) — Setup Crítico

**Objetivo:** Entorno listo, credenciales validadas, BD operativa  
**Horas disponibles:** 16h

| # | Story | Puntos | Descripción |
|---|-------|--------|-------------|
| 1 | Semana 1: NTP Synchronization (CRÍTICO) | **1** | Garantizar sincronización NTP en servidor local/cloud. AWS Sig V4 requiere ±15 minutos. Verificar con: `date +%s` vs epochconverter.com |
| 2 | Semana 1: Reunión BigData - Proyecto BigQuery | **3** | Coordinar con equipo BigData: ¿Proyecto disponible? ¿Dataset? ¿Acceso a la API? Obtener credenciales service account. |
| 3 | Semana 1: Verificar Credenciales Amazon API | **5** | Validar acceso Amazon Incentives API. Documentación completa. ¿Sandbox disponible? Extraer: PARTNER_ID, ACCESS_KEY, SECRET_KEY |
| 4 | Semana 1: Confirmar SendGrid Contratado | **3** | ¿Cuenta SendGrid existente? Obtener API_KEY y FROM_EMAIL. Si no existe, gestionar contratación con proveedor. |
| 5 | Semana 1: Crear Proyecto GCP y Configurar Entorno | **5** | Crear proyecto en Google Cloud. Habilitar APIs: BigQuery, Cloud Run, Cloud Logging, Cloud Scheduler. Configurar billing. |
| 6 | Semana 1: Crear Repo Privado GitHub con Branch Protection | **3** | Crear repo privado. Configurar branch protection en main (PR requerido). Generar SSH key. GitHub Actions debe ejecutar tests automáticamente. |
| 7 | Semana 1: Coordinar BigData - Dataset + Acceso | **3** | Crear dataset en BigQuery. Dar acceso a Developer. Validar permisos: read/write tables, create tables. |
| 8 | Semana 1: Confirmar Campo Email - Módulo Referidos | **2** | Coordinar con equipo Zoho: ¿Qué campo del módulo Referidos contiene el email del alumno? Documentar field name exacto. |
| 9 | Semana 1: Confirmar Importe Gift Card con Marketing | **1** | ¿Monto fijo o variable? ¿Currency por defecto? Documentar. Asumir USD $50 si no especifica. |

---

## SEMANA 2: 26-30 Mayo (Lunes-Viernes) — Desarrollo API Core

**Objetivo:** API funcional en desarrollo, endpoints listos  
**Horas disponibles:** 40h

| # | Story | Puntos | Descripción |
|---|-------|--------|-------------|
| 1 | Semana 2: Estructura Express + Middleware Chain | **3** | Crear src/index.js. Middleware: JSON parser, auth (API Key), logger, error handler. Health check en GET /health |
| 2 | Semana 2: Implementar AWS Signature V4 con aws4 | **5** | Crear src/services/amazon.js. Usar librería aws4 para firmar requests. Validar timestamp sincronizado. Generar creationRequestId UUID. |
| 3 | Semana 2: Encriptación AES-256 GCM | **5** | Crear src/utils/encryption.js. Método encrypt() y decrypt(). Format: IV (16b) || authTag (16b) || ciphertext en base64. Validar clave 32 bytes. |
| 4 | Semana 2: Tabla BigQuery: gift_cards + access_logs | **5** | Crear sql/create_tables.sql. Schema exacto del plan. Constraints: referido_id UNIQUE, amazon_creation_request_id UNIQUE. Ejecutar en GCP. |
| 5 | Semana 2: Sanitizer Middleware - Remover Datos Sensibles | **3** | Crear src/middleware/sanitizer.js. Patrones: códigos Amazon, AWS keys, SendGrid keys, tokens, IPs. Función sanitize() se aplica a todos los logs. |
| 6 | Semana 2: Rate Limiting - Reenvíos Máximo 5 | **5** | Crear src/middleware/rateLimit.js. Límites: 1/hora, 3/día, 5/total por gift card. Almacenamiento en memoria con cleanup automático c/10min. |
| 7 | Semana 2: Endpoint POST /gift-cards/process (Paso 1-3) | **8** | Recibir datos. Validar entrada. Buscar si existe (idempotencia). Si existe → reenvío. Si NO existe → validar requisitos en Zoho (20+ días, invoice matriculado). |
| 8 | Semana 2: Endpoint POST /gift-cards/process (Paso 4-6) | **8** | Verificar fondos Amazon. Generar código con reintentos (F400: 3x, backoff 100/200/400ms). Encriptar AES-256. Guardar en BigQuery. Registrar en access_logs. |
| 9 | Semana 2: Endpoint POST /gift-cards/resend | **3** | Buscar código existente. Desencriptar en memoria. Registrar "resent" en access_logs. Usar email original de BD (no el de Zoho). Actualizar counters. |
| 10 | Semana 2: SendGrid Integration - sendgrid.js | **5** | Crear src/services/sendgrid.js. Método send() con template. Desencriptar código SOLO para SendGrid. Nullificar variable. Registrar messageId. Alert system para fondos insuficientes. |
| 11 | Semana 2: Logging Seguro - logger.js | **3** | Crear src/utils/logger.js. Métodos: info(), error(), warn(), debug(), audit(). TODO sanitizado. NUNCA logear códigos en texto plano. |
| 12 | Semana 2: Servicios Zoho + BigQuery | **3** | Crear src/services/zoho.js y completar src/services/bigquery.js. Métodos: validación invoices, búsqueda referido, save/find giftCard, logAction(). |
| 13 | Semana 2: Tests Unitarios - Encriptación | **3** | tests/unit/encryption.test.js. Validar encrypt/decrypt round-trip. IVs diferentes = ciphertexts diferentes. Error handling. |
| 14 | Semana 2: Tests Unitarios - Sanitizer | **2** | tests/unit/sanitizer.test.js. Remover códigos, AWS keys, SendGrid keys. Múltiples sensibles. Idempotencia. Normal data intacta. |
| 15 | Semana 2: Tests Unitarios - Rate Limiting | **3** | tests/unit/rateLimit.test.js. Primer reenvío OK. 2do en <1h bloqueado. Después de 1h permitido. 4to en mismo día bloqueado. 6to total bloqueado. |

---

## SEMANA 3: 2-6 Junio (Lunes-Viernes) — Deploy + CRM Integration

**Objetivo:** API en producción, CRM integrado, ACME con acceso  
**Horas disponibles:** 40h

| # | Story | Puntos | Descripción |
|---|-------|--------|-------------|
| 1 | Semana 3: Dockerfile Multi-stage + docker-compose | **3** | Crear Dockerfile (Node 18 alpine, non-root user). docker-compose.yml con app + postgres. Health check. Expone puerto 3000. |
| 2 | Semana 3: Plantilla SendGrid + Variables Dinámicas | **3** | Diseñar plantilla HTML en SendGrid. Variables: {{nombre}}, {{amazonCode}}. Testear con datos de prueba. |
| 3 | Semana 3: Configuración Cloud Run - app.yaml | **3** | Crear app.yaml: Node 18, 1 CPU, 1GB memoria, auto-scaling 1-10, HTTPS required, timeout 600s, custom entrypoint. |
| 4 | Semana 3: Build + Deploy Docker a Cloud Run | **5** | Ejecutar script deploy-cloud-run.sh. Build imagen. Push a gcr.io. Deploy a Cloud Run. Verificar health check. Obtener URL pública. |
| 5 | Semana 3: Configurar Cloud Logging e IAM | **5** | Activar Cloud Logging en Cloud Run. Crear rol "Gift Cards Auditor" (solo lectura). Asignar a IT/compliance/dirección de ACME. Retención 1 año mínimo. |
| 6 | Semana 3: Alertas Automáticas en GCP | **3** | Configurar alertas: >3 errores Amazon en 1h, acceso a gift_cards desde IP inesperada, fondos insuficientes (F300). Email a crm@acme-example.com |
| 7 | Semana 3: Campos Zoho Referidos - Auditoría | **2** | Crear fields en módulo Referidos: Gift_Card_Enviada (checkbox), Gift_Card_Enviada_Fecha, Gift_Card_SendGrid_ID, Gift_Card_Email_Status (dropdown), Gift_Card_Reenvios, Gift_Card_Ultimo_Reenvio |
| 8 | Semana 3: Scheduler Zoho Deluge - 20+ Días | **5** | Crear scheduler automático diario en Zoho. Query: referidos con 20+ días sin código. Llamar POST /gift-cards/process. Manejar respuestas (success/error). Actualizar campos según response. |
| 9 | Semana 3: Custom Button "Relanzar Gift Card" | **3** | Crear botón en módulo Referidos. Llama POST /gift-cards/resend. Visible si Gift_Card_Enviada=true. Actualiza Gift_Card_Ultimo_Reenvio y Gift_Card_Reenvios. |
| 10 | Semana 3: Integración Zoho → API → BigQuery | **5** | Test end-to-end: crear referido, ejecutar scheduler, verificar datos en BigQuery, recibir email. Validar encriptación. Zoho actualizado correctamente. |
| 11 | Semana 3: Setup BigQuery Script - setup-bigquery.js | **3** | scripts/setup-bigquery.js: validar credenciales, crear dataset, crear tablas, configurar IAM, verificar permisos. Ejecutable vía `npm run setup:bigquery` |
| 12 | Semana 3: Cloud Scheduler Setup Script | **2** | scripts/cloud-scheduler-setup.sh: crear service account, crear job diario 3 AM UTC, configurar IAM, OIDC auth. |
| 13 | Semana 3: NTP Sync Script | **2** | scripts/ntp-sync.sh: macOS (sntp/ntpdate), Linux (timedatectl/ntpd/chrony), Windows (w32tm). Verifica offset <15 seg. Crítico para AWS Sig V4. |
| 14 | Semana 3: Cloud Run Deploy Script | **2** | scripts/deploy-cloud-run.sh: build, push a gcr.io, deploy a Cloud Run, verificar health, output URL. Recordatorios: Secret Manager, Cloud Scheduler. |

---

## SEMANA 4: 9-10 Junio (Lunes-Martes) — Testing Final + Go Live

**Objetivo:** Sistema en PRODUCCIÓN, ACME con acceso, equipo capacitado  
**Horas disponibles:** 16h

| # | Story | Puntos | Descripción |
|---|-------|--------|-------------|
| 1 | Semana 4: Test - Flujo Nuevo Completo | **5** | Crear 3-5 registros prueba con fecha 21 días atrás. Ejecutar scheduler. Verificar: código generado, ENCRIPTADO en BD, email enviado. referido_id UNIQUE. access_logs registra "generated". |
| 2 | Semana 4: Test - Reenvío Automático | **3** | Ejecutar scheduler 2da vez. Verificar: NO llama Amazon, reutiliza código existente. email_resent_count incremented. access_logs registra "resent". |
| 3 | Semana 4: Test - Validaciones Fallidas | **3** | Crear referido con <20 días. Crear sin invoice. Scheduler no envía. access_logs registra "validation_failed". Mensajes de error claros. |
| 4 | Semana 4: Test - Seguridad en Logs | **3** | Buscar código en Cloud Logging → ❌ NO aparece. Buscar en access_logs → ❌ NO aparece. Verificar ENCRIPTADO en gift_cards → ✅. Botón "Relanzar" funciona. |
| 5 | Semana 4: Test - Errores Amazon (F400, F300) | **5** | Simular F400 → reintenta 3 veces OK. Simular F300 → email a crm@ sobre fondos. Verificar idempotencia (creationRequestId no duplica). |
| 6 | Semana 4: Cambiar a Producción - AMAZON_ENV | **1** | Actualizar .env: AMAZON_ENV=production. Deploy a Cloud Run. Verificar URL y endpoints listos. |
| 7 | Semana 4: Pruebas Producción - Bajo Monto | **2** | 2-3 pruebas reales con $5 máximo. Cadena completa: Zoho → API → BigQuery → SendGrid → email real. Auditoría en Cloud Logging. |
| 8 | Semana 4: Documentación + Troubleshooting | **3** | README con: endpoints, errores comunes, logs en Cloud Logging, cómo auditar accesos, pasos para soporte. Entregar a equipo. |
| 9 | Semana 4: Entregar Acceso Cloud Logging a ACME | **1** | IAM: asignar rol "Gift Cards Auditor" a IT/compliance/dirección. Verificar acceso. Explicar interfaz. |
| 10 | Semana 4: Briefing Final al Equipo | **1** | Reunión: arquitectura, flujos, seguridad, auditoría. Preguntas. Confirmación de go-live. |

---

## RESUMEN POR SEMANA

| Semana | Período | Stories | Puntos Totales | Horas Disponibles | Estado |
|--------|---------|---------|-----------------|-------------------|--------|
| **1** | 22-23 mayo | 9 | 26 | 16h | Setup + Validaciones |
| **2** | 26-30 mayo | 15 | 59 | 40h | Desarrollo API |
| **3** | 2-6 junio | 14 | 48 | 40h | Deploy + CRM |
| **4** | 9-10 junio | 10 | 27 | 16h | Testing + Go Live |
| **TOTAL** | 22 mayo - 10 junio | **48** | **160** | **112h** | ✅ PRODUCCIÓN |

---

## Notas para Zoho Sprints

**Cómo importar a Zoho:**
1. Crear Epic: "Sistema Gift Cards" 
2. Crear 4 Sprints (una por semana)
3. Copiar cada story con puntuación fibonacci
4. Asignar al Developer
5. Configurar Backlog view para seguimiento diario
6. Activar GitHub Actions para CI/CD automático

**Puntuación Fibonacci utilizada:** 1, 2, 3, 5, 8

**Capacidad estimada:** 160 puntos / 4 semanas = ~40 puntos/semana  
**Velocidad disponible:** 112 horas disponibles / 54 horas estimadas = **58 horas de margen** para impredvistos

---

**Última actualización:** 22 Mayo 2026  
**Estado:** Listo para importar en Zoho Sprints
