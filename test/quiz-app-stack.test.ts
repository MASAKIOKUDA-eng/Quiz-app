import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { QuizAppStack } from '../lib/quiz-app-stack';

/**
 * Fine-grained assertion tests over the synthesized CloudFormation
 * template. The stack is synthesized in-memory (no AWS calls). The
 * NodejsFunction bundling runs esbuild at synth time using the local
 * esbuild dependency (no Docker required) in a networked environment.
 *
 * Assertions intentionally avoid generated logical IDs and only match
 * on resource types and properties, so they stay resilient to CDK
 * internals changing.
 */
describe('QuizAppStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new QuizAppStack(app, 'TestQuizAppStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  test('provisions exactly one DynamoDB table with on-demand billing', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('API Lambda runs on ARM64 with a Node runtime', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Architectures: ['arm64'],
      Runtime: Match.stringLikeRegexp('^nodejs'),
    });
  });

  test('exposes an HTTP API (API Gateway v2)', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
    });
  });

  test('defines the four expected routes', () => {
    const routeKeys = [
      'GET /api/quizzes',
      'GET /api/quizzes/{quizId}',
      'POST /api/quizzes/{quizId}/submit',
      'POST /api/admin/quizzes',
    ];
    // There should be exactly four routes wired up (3 public + 1 admin).
    template.resourceCountIs('AWS::ApiGatewayV2::Route', routeKeys.length);
    for (const routeKey of routeKeys) {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: routeKey,
      });
    }
  });

  test('provisions a Cognito User Pool with self sign-up disabled', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: Match.objectLike({
        AllowAdminCreateUserOnly: true,
      }),
    });
  });

  test('provisions a public User Pool client (no client secret)', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
    });
  });

  test('provisions a Cognito Hosted UI domain', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
  });

  test('defines a JWT authorizer for the admin route', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
    });
  });

  test('admin route is protected by the JWT authorizer', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /api/admin/quizzes',
      AuthorizationType: 'JWT',
      AuthorizerId: Match.anyValue(),
    });
  });

  test('public routes have no authorizer', () => {
    const publicRouteKeys = [
      'GET /api/quizzes',
      'GET /api/quizzes/{quizId}',
      'POST /api/quizzes/{quizId}/submit',
    ];
    for (const routeKey of publicRouteKeys) {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: routeKey,
        // Public routes are open: no AuthorizerId is attached and the
        // authorization type renders as 'NONE'.
        AuthorizerId: Match.absent(),
        AuthorizationType: 'NONE',
      });
    }
  });

  test('fronts the SPA with a CloudFront distribution using PriceClass_100', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        PriceClass: 'PriceClass_100',
      }),
    });
  });

  test('routes /api/* through CloudFront to the HTTP API origin', () => {
    // The SPA reaches the API same-origin via a dedicated cache behavior,
    // so no manual config.js edit is required after deploy.
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: 'api/*' }),
        ]),
      }),
    });
  });

  test('static site bucket blocks all public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });
});
