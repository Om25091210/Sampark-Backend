locals {
  # Every resource name is prefixed with this. Keeps a future `environment = "production"`
  # from colliding with staging inside the same account.
  name_prefix = "${var.project}-${var.environment}"

  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  # Subnet CIDRs pair with AZs by index: public_subnet_cidrs[0] lands in availability_zones[0].
  az_count = length(var.availability_zones)

  # ECS names live here because iam.tf must scope the GitHub Actions role to the
  # service ARN before ecs.tf exists to be referenced. Both files read these, so a
  # rename stays consistent. The ARN below is assembled by hand for the same reason.
  ecs_cluster_name = "${local.name_prefix}-cluster"
  ecs_service_name = "${local.name_prefix}-backend-service"
  ecs_service_arn  = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${local.name_prefix}-cluster/${local.name_prefix}-backend-service"

  # Project / Environment / Owner / ManagedBy are applied to every resource by the
  # provider's default_tags block. Resources below add only a Name tag.
}
