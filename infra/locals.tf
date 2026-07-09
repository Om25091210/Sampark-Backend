locals {
  # Every resource name is prefixed with this. Keeps a future `environment = "production"`
  # from colliding with staging inside the same account.
  name_prefix = "${var.project}-${var.environment}"

  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  # Subnet CIDRs pair with AZs by index: public_subnet_cidrs[0] lands in availability_zones[0].
  az_count = length(var.availability_zones)

  # Project / Environment / Owner / ManagedBy are applied to every resource by the
  # provider's default_tags block. Resources below add only a Name tag.
}
