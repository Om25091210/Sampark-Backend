resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db-subnets"
  subnet_ids = aws_subnet.private[*].id

  description = "SAMPARK RDS: private subnets only, no route to the internet"

  tags = { Name = "${local.name_prefix}-db-subnets" }
}

# No aws_db_parameter_group: the default postgres16 group is sufficient for this
# phase. Add one only when a parameter actually needs changing -- an empty custom
# group is churn, and attaching one later forces a reboot either way.

resource "aws_db_instance" "main" {
  identifier = "${local.name_prefix}-db"

  # engine_version is pinned. AWS's default for the `postgres` engine is currently
  # 18.3 -- leaving this unset silently provisions PostgreSQL 18, three majors past
  # the version this project targets. We pin 16.14 (newest 16.x in ap-south-1) for
  # parity with docker-compose.yml, the committed Prisma migration, and the
  # integration tests, all of which are built against PostgreSQL 16.
  #
  # A major-version DOWNGRADE cannot be done in place: changing this to a lower
  # major forces a destroy-and-recreate, which deletion_protection will block.
  # Local docker-compose must match. Update both together on any version bump.
  engine         = "postgres"
  engine_version = "16.14"
  instance_class = "db.t3.micro"

  db_name  = "sampark"
  username = "sampark_app"

  # RDS generates the master password, stores it in a secret it owns, and rotates
  # it. Terraform never receives the value, so nothing sensitive lands in state.
  # The generated secret is separate from sampark/staging; DATABASE_URL is
  # assembled from it by hand after this apply.
  manage_master_user_password = true

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = false

  # Windows are UTC. 21:30-22:30 UTC = 03:00-04:00 IST (daily backup).
  # sat:22:30-sat:23:30 UTC = Sunday 04:00-05:00 IST (weekly maintenance).
  # They must not overlap; these are adjacent, not overlapping.
  # backup_retention_period: 1 day retention for staging under
  # the AWS Free Plan (7 days would require a paid account and
  # is not justified for seeded test data). When environment
  # flips to "production" this must go to 7 days minimum, and
  # the account must be on a paid plan by then. See ADR-015
  # for the staging-vs-production configuration decision record.
  backup_retention_period = 1
  backup_window           = "21:30-22:30"
  maintenance_window      = "sat:22:30-sat:23:30"
  copy_tags_to_snapshot   = true

  # Deferred to Phase 2, alongside Multi-AZ, VPC endpoints, and main-only OIDC.
  performance_insights_enabled = false
  monitoring_interval          = 0

  # Guards against a misfired `terraform destroy`. To actually tear this down you
  # must first set this false and apply, or flip it in the console. Note the
  # interaction with skip_final_snapshot below: hard to delete, but once deleted
  # there is no snapshot to restore from. That is the intent for staging.
  deletion_protection = true
  skip_final_snapshot = true

  # Changes wait for the maintenance window rather than interrupting the service.
  apply_immediately = false

  # auto_minor_version_upgrade = false: version bumps
  # are explicit HCL changes to keep Terraform state and
  # docker-compose local dev in sync. Security patches
  # applied manually via engine_version update + apply.
  auto_minor_version_upgrade = false

  tags = { Name = "${local.name_prefix}-db" }
}
