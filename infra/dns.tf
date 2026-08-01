# TLS for the staging ALB (Phase 2 item from DESIGN.md, now real: the domain is
# `bsmart.net.in`, registered at GoDaddy). GoDaddy is not the DNS provider -- the
# zone below must be delegated to Route 53 by pasting its name_servers output into
# GoDaddy's nameserver settings for the domain, otherwise neither the ACM DNS
# validation record nor the api A-record below is publicly resolvable.
#
# Cost: ~Rs 43/month hosted zone + negligible query charges. The ACM cert itself
# is free.

resource "aws_route53_zone" "main" {
  name = var.route53_zone_name

  tags = { Name = "${local.name_prefix}-zone" }
}

resource "aws_acm_certificate" "api" {
  domain_name       = var.api_domain_name
  validation_method = "DNS"

  # An ALB can only attach a certificate issued in its own region (ap-south-1,
  # the provider default -- see providers.tf).
  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${local.name_prefix}-cert" }
}

# One CNAME per domain on the cert (currently one: api_domain_name). for_each
# rather than a fixed record so this does not need editing if the cert ever
# covers more than one name.
resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.api.domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }

  zone_id = aws_route53_zone.main.zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.value]
}

resource "aws_acm_certificate_validation" "api" {
  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]

  # Generous: this blocks on the user completing the GoDaddy nameserver change
  # and public DNS propagating, not just on AWS-side processing.
  timeouts {
    create = "60m"
  }
}

resource "aws_route53_record" "api" {
  zone_id = aws_route53_zone.main.zone_id
  name    = var.api_domain_name
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
