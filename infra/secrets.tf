# Runtime secrets, injected into the ECS task as environment variables by the task
# EXECUTION role at container start. The application never calls Secrets Manager.
#
# S3_BUCKET is deliberately absent: it is not a secret. It is passed as a plain
# environment variable in the task definition, sourced from aws_s3_bucket.media.
resource "aws_secretsmanager_secret" "app" {
  name        = "${var.project}/${var.environment}"
  description = "SAMPARK backend runtime secrets (${var.environment})"

  # AWS-managed key. A CMK buys nothing here and costs ~$1/month.
  kms_key_id = null

  # Staging only: destroy deletes immediately instead of holding the name hostage
  # for 7-30 days. Terraform could not otherwise recreate a secret of the same name.
  # This MUST become >= 7 before this config is used for production.
  recovery_window_in_days = 0

  tags = { Name = "${var.project}/${var.environment}" }
}

# Placeholder values only. The real DATABASE_URL and JWT_SECRET are written by hand
# after the first apply -- see infra/README.md.
#
# ignore_changes on secret_string is load-bearing, not decorative. Without it, the
# next `terraform apply` would diff the live (rotated) value against the placeholder
# below and quietly overwrite the real credentials, breaking the running service.
# Terraform must create this secret version once and never look at it again.
resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id

  secret_string = jsonencode({
    DATABASE_URL = "placeholder"
    JWT_SECRET   = "placeholder"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
