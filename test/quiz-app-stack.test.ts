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

  test('defines the seven expected routes', () => {
    const routeKeys = [
      'GET /api/quizzes',
      'GET /api/quizzes/{quizId}',
      'POST /api/quizzes/{quizId}/submit',
      'POST /api/admin/quizzes',
      'GET /api/admin/quizzes/{quizId}',
      'PUT /api/admin/quizzes/{quizId}',
      'DELETE /api/admin/quizzes/{quizId}',
    ];
    // There should be exactly seven routes wired up (3 public + POST admin
    // create + GET/PUT/DELETE admin single-quiz).
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

  test('admin routes are protected by the JWT authorizer', () => {
    const adminRouteKeys = [
      'POST /api/admin/quizzes',
      'GET /api/admin/quizzes/{quizId}',
      'PUT /api/admin/quizzes/{quizId}',
      'DELETE /api/admin/quizzes/{quizId}',
    ];
    for (const routeKey of adminRouteKeys) {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: routeKey,
        AuthorizationType: 'JWT',
        AuthorizerId: Match.anyValue(),
      });
    }
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

  test('does NOT host the frontend via CloudFront or an S3 site bucket', () => {
    // FEAT-004: the frontend moved to Amplify Hosting (console-managed).
    // The old S3 static-site bucket + CloudFront distribution were removed,
    // so the synthesized template must contain neither. (No other resource
    // in this stack legitimately creates a CloudFront distribution or an
    // S3 bucket, so a plain count-of-zero assertion is safe.)
    template.resourceCountIs('AWS::CloudFront::Distribution', 0);
    template.resourceCountIs('AWS::S3::Bucket', 0);
  });

  test('HTTP API CORS is scoped to the Amplify origin and allows edit/delete methods', () => {
    // The Amplify-hosted SPA calls the API cross-origin. The admin routes
    // send `Authorization: Bearer <jwt>`, so the CORS preflight must allow
    // the 'authorization' header (alongside 'content-type'). AllowOrigins is
    // tightened to the specific Amplify domain (NOT '*'), and PUT/DELETE are
    // allowed for the admin edit/delete routes.
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
      CorsConfiguration: Match.objectLike({
        AllowHeaders: Match.arrayWith(['authorization']),
        AllowOrigins: ['https://main.d2uwsqpk41y7so.amplifyapp.com'],
        AllowMethods: Match.arrayWith([
          'GET',
          'POST',
          'PUT',
          'DELETE',
          'OPTIONS',
        ]),
      }),
    });
  });

  test('CORS AllowOrigins does NOT contain a wildcard', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: Match.not(Match.arrayWith(['*'])),
      }),
    });
  });

  test('the Lambda receives the ALLOWED_ORIGIN env var matching the CORS origin', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          ALLOWED_ORIGIN: 'https://main.d2uwsqpk41y7so.amplifyapp.com',
        }),
      }),
    });
  });

  test('exposes only the expected CfnOutputs (CloudFrontDomain removed)', () => {
    // ApiEndpoint / TableName / Cognito outputs remain; the CloudFrontDomain
    // output is gone now that CloudFront hosting was removed.
    template.hasOutput('ApiEndpoint', {});
    template.hasOutput('TableName', {});
    template.hasOutput('UserPoolId', {});
    template.hasOutput('UserPoolClientId', {});
    template.hasOutput('UserPoolHostedUiDomain', {});
    expect(() => template.hasOutput('CloudFrontDomain', {})).toThrow();
  });
});
