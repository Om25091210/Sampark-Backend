resource "aws_vpc" "main" {
  cidr_block = var.vpc_cidr

  # Both required for RDS private DNS resolution and for ECS tasks to resolve
  # ECR / Secrets Manager endpoints.
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${local.name_prefix}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "${local.name_prefix}-igw" }
}

# ---------------------------------------------------------------------------
# Public subnets -- ALB *and* Fargate tasks (Open Decision 1: no NAT Gateway).
#
# Tasks get a public IP so they can reach ECR, Secrets Manager, S3 and CloudWatch
# over the IGW. They are NOT publicly reachable: fargate-sg accepts inbound only
# from alb-sg. The security group is the access control, not the subnet tier.
# This trades a small amount of network isolation for ~Rs 3,400/month.
# ---------------------------------------------------------------------------

resource "aws_subnet" "public" {
  count = local.az_count

  vpc_id            = aws_vpc.main.id
  cidr_block        = var.public_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  map_public_ip_on_launch = true

  tags = {
    Name = "${local.name_prefix}-public-${var.availability_zones[count.index]}"
    Tier = "public"
  }
}

# ---------------------------------------------------------------------------
# Private subnets -- RDS only. No route to 0.0.0.0/0, so no egress to the
# internet and no path in from it.
# ---------------------------------------------------------------------------

resource "aws_subnet" "private" {
  count = local.az_count

  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = {
    Name = "${local.name_prefix}-private-${var.availability_zones[count.index]}"
    Tier = "private"
  }
}

# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "${local.name_prefix}-rt-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  count = local.az_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# A subnet must always be associated with some route table. This one carries only
# the implicit `local` route for the VPC CIDR -- that absence of a 0.0.0.0/0 entry
# is exactly what makes these subnets private. There is no NAT Gateway to point at.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "${local.name_prefix}-rt-private" }
}

resource "aws_route_table_association" "private" {
  count = local.az_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}
