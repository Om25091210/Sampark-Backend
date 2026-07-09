provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

  # Every resource that supports tagging inherits these. Individual resources add
  # only a Name tag; they never restate these four.
  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      Owner       = var.owner
      ManagedBy   = "Terraform"
    }
  }
}

# Account id for resource names (S3 bucket suffix) and IAM ARNs. Never hardcoded.
#
# The postcondition is a guardrail, not decoration: root credentials cannot be
# scoped or revoked without locking out the account owner, so Terraform must never
# run as root. A `check` block would only warn -- a postcondition fails the plan.
data "aws_caller_identity" "current" {
  lifecycle {
    postcondition {
      condition     = !endswith(self.arn, ":root")
      error_message = "Refusing to run as the AWS account root user. Use profile sampark-admin (see infra/README.md)."
    }
  }
}

data "aws_region" "current" {}
