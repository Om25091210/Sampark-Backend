# Destination for the task definition's awslogs driver. Created here rather than
# letting ECS auto-create it (`awslogs-create-group`), so retention is enforced --
# an auto-created group retains logs forever and bills forever.
resource "aws_cloudwatch_log_group" "backend" {
  name              = "/ecs/${var.project}-backend"
  retention_in_days = 30

  # Staging uses the AWS-owned key. A customer-managed KMS key would add ~$1/month
  # plus per-request charges for no benefit at this tier.

  tags = { Name = "/ecs/${var.project}-backend" }
}
