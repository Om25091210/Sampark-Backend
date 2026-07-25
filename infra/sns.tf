# ADR-048. Real push notification delivery via AWS SNS Mobile Push, backed by FCM V1
# (service-account) credentials -- a deliberate, narrow, documented exception to the
# data-residency rule (root CLAUDE.md; see BC-THESIS-SAMPARK.md ADR-048). Everything
# EXCEPT the final hop to Google's FCM servers stays in AWS Mumbai: this platform
# application, the endpoint/publish calls (from the ecs_task role, iam.tf), and the
# DeviceToken/Notification rows all live here.
#
# HUMAN SETUP REQUIRED BEFORE `terraform apply` (Claude has no console/cloud
# credentials and cannot do these):
#   1. Create a Firebase project and register the Android app
#      (package: com.bitcrackers.sampark); this is free and does not require
#      publishing the app.
#   2. Firebase console -> Project Settings -> Service Accounts -> generate a new
#      private key. This JSON is what FCM V1's "Token" auth method needs.
#   3. Hand-add it to the EXISTING secret blob (infra/secrets.tf) as a new JSON key,
#      the same way JWT_SECRET/IMPORT_API_KEY are set -- BEFORE running apply, since
#      the data source below reads it live:
#        aws secretsmanager put-secret-value --secret-id "${var.project}/${var.environment}" \
#          --secret-string "$(aws secretsmanager get-secret-value \
#            --secret-id "${var.project}/${var.environment}" --query SecretString --output text \
#            | jq -c --arg k "$(cat service-account.json)" '. + {FIREBASE_SERVICE_ACCOUNT_JSON:$k}')" \
#          --profile sampark-admin
#
# KNOWN ISSUE: hashicorp/terraform-provider-aws#20309 -- *updating* platform_credential
# on an existing aws_sns_platform_application can fail with "Platform credentials
# invalid" even when the value is correct. A future credential rotation may need a
# manual console/CLI workaround plus `terraform import`, not a plain re-apply.
data "aws_secretsmanager_secret_version" "app_current" {
  secret_id = aws_secretsmanager_secret.app.id
}

locals {
  firebase_service_account_json = jsondecode(data.aws_secretsmanager_secret_version.app_current.secret_string)["FIREBASE_SERVICE_ACCOUNT_JSON"]
}

# `platform = "GCM"` is unchanged from the legacy API -- AWS did not introduce a new
# platform string for FCM V1. Only the CONTENT of platform_credential differs (a
# service-account JSON, not a server key), which flips the resulting
# AuthenticationMethod attribute from "Key" to "Token". Verify after apply:
#   aws sns get-platform-application-attributes --platform-application-arn <arn>
# should report AuthenticationMethod = Token.
resource "aws_sns_platform_application" "fcm" {
  name                = "${local.name_prefix}-fcm-android"
  platform            = "GCM"
  platform_credential = local.firebase_service_account_json
  # No `tags` argument -- aws_sns_platform_application does not support resource tags.
}
