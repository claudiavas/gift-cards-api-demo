# Documentación - Gift Cards API

## Archivos principales

### 📋 [PLAN.md](./PLAN.md)
Plan de implementación completo (22 mayo - 10 junio 2026):
- **4 semanas** de desarrollo
- **14 días hábiles** de trabajo
- **54 horas** estimadas
- Arquitectura de seguridad detallada
- Timeline por semana
- Desglose de tareas

**Índice del plan:**
- Contexto y justificación arquitectónica
- Flujo completo de la aplicación
- Tablas BigQuery y schemas
- Endpoints API documentados
- Seguridad (encriptación, logging, auditoría)
- Backup strategy (Cloud Storage)
- AWS Signature V4 (autenticación Amazon)
- Reintentos con backoff exponencial
- Idempotencia con creationRequestId
- Timeline por semana (1-4)

### 🏗️ [ARQUITECTURA.png](./ARQUITECTURA.png)
Diagrama visual de la arquitectura de seguridad:
- Flujo de la campaña
- Zonas de seguridad (pública/privada)
- Componentes (Zoho CRM, API Node.js, BigQuery, Cloud Logging, SendGrid, Amazon)
- Aislamiento de datos sensibles
- Auditoría inmutable

## Cómo usar esta documentación

1. **Para entender la arquitectura:** Ver `ARQUITECTURA.png`
2. **Para implementar:** Seguir `PLAN.md` semana por semana
3. **Para detalles técnicos:** Ir a secciones específicas del PLAN.md

## Requisitos antes de empezar (Semana 1)

✅ Credenciales AWS/BigQuery/Amazon (ya disponibles)
✅ Acceso a GitHub (SSH configurado)
✅ Google Cloud Project
✅ BigQuery dataset
✅ SendGrid API key
✅ Zoho CRM access

## Go live

**Fecha objetivo:** 10 de junio 2026
**Status:** En planificación
**Responsable:** Maria Vasquez (claudia.vasquez.as@gmail.com)

---

*Plan de Implementación - Integración Amazon y Custodia de Códigos de Tarjetas Regalo*
