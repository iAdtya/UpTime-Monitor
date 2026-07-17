# Light image: slim is ~130 MB on disk vs ~1 GB for the full python image.
FROM python:3.12-slim

WORKDIR /app

# Install deps first so this layer is cached unless requirements.txt changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code (data/ and logs/ are excluded via .dockerignore;
# they come in as mounted volumes at runtime instead).
COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
