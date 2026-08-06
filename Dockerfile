# ============================================================================
# Dockerfile para Gift Cards API
#
# Construir: docker build -t gift-cards-api:latest .
# Ejecutar: docker run -p 3000:3000 --env-file .env gift-cards-api:latest
# ============================================================================

# Stage 1: Build
FROM node:18-alpine AS builder

WORKDIR /app

# Copiar package.json y instalar dependencias
COPY package.json package-lock.json ./
RUN npm ci --only=production

# Stage 2: Runtime
FROM node:18-alpine

# Metadatos
LABEL maintainer="Maria Vasquez <claudia.vasquez.as@gmail.com>"
LABEL description="Gift Cards API - Amazon tarjetas regalo seguras con encriptación"

WORKDIR /app

# Copiar dependencias del builder
COPY --from=builder /app/node_modules ./node_modules

# Copiar código de la aplicación
COPY src/ ./src/
COPY public/ ./public/
COPY package.json ./

# Crear usuario no-root (seguridad)
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Exponer puerto
EXPOSE 3000

# Iniciar aplicación
CMD ["node", "src/index.js"]
