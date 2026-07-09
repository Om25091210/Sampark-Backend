# Remote state: S3 for storage, DynamoDB for locking.
#
# The bucket and the lock table are the only two AWS resources in this project that
# are NOT managed by Terraform -- they were created by hand via the AWS CLI, because
# a state backend cannot store the state that describes itself. Do not import them.
#
# Terraform evaluates this block before variables exist, so bucket/region/profile
# must be literals here. This is the one place the "no hardcoded region" rule in
# the project plan cannot be honoured; it is a Terraform limitation, not a choice.
terraform {
  backend "s3" {
    bucket = "sampark-terraform-state-231378335677"
    key    = "sampark/staging/terraform.tfstate"
    region = "ap-south-1"

    dynamodb_table = "sampark-terraform-locks"
    encrypt        = true

    profile = "sampark-admin"
  }
}
