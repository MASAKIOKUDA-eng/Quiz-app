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

  test('the DynamoDB table has TTL enabled on the ttl attribute', () => {
    // FEAT-002: battle ROOM#/CONN#/PLAYER# items auto-expire via `ttl`.
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: {
        AttributeName: 'ttl',
        Enabled: true,
      },
    });
  });

  test('API Lambda runs on ARM64 with a Node runtime', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Architectures: ['arm64'],
      Runtime: Match.stringLikeRegexp('^nodejs'),
    });
  });

  test('provisions two ARM64 Lambda functions (HTTP API + WebSocket)', () => {
    // FEAT-002 adds a second (WebSocket) Lambda; both are ARM64.
    template.resourceCountIs('AWS::Lambda::Function', 2);
    const fns = template.findResources('AWS::Lambda::Function');
    for (const key of Object.keys(fns)) {
      expect(fns[key].Properties.Architectures).toEqual(['arm64']);
    }
  });

  test('exposes an HTTP API (API Gateway v2)', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
    });
  });

  test('exposes a WebSocket API (API Gateway v2) for realtime battle', () => {
    // FEAT-002: a separate WEBSOCKET-protocol API is provisioned alongside
    // the untouched HTTP API.
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'WEBSOCKET',
    });
    // Exactly two API Gateway v2 APIs: the HTTP API + the WebSocket API.
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 2);
  });

  test('defines the seven HTTP routes unchanged (scoped by RouteKey)', () => {
    // The 7 HTTP routes are asserted by RouteKey. WebSocket routes are
    // separate AWS::ApiGatewayV2::Route resources with $connect/etc. keys,
    // so we no longer use a blanket resourceCountIs over all routes; instead
    // we count HTTP routes by matching the '/api/...' RouteKey shape.
    const httpRouteKeys = [
      'GET /api/quizzes',
      'GET /api/quizzes/{quizId}',
      'POST /api/quizzes/{quizId}/submit',
      'POST /api/admin/quizzes',
      'GET /api/admin/quizzes/{quizId}',
      'PUT /api/admin/quizzes/{quizId}',
      'DELETE /api/admin/quizzes/{quizId}',
    ];
    for (const routeKey of httpRouteKeys) {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: routeKey,
      });
    }
    // Exactly seven routes whose RouteKey contains '/api/' (the HTTP routes).
    const allRoutes = template.findResources('AWS::ApiGatewayV2::Route');
    const apiRoutes = Object.values(allRoutes).filter((r) => {
      const rk = r.Properties?.RouteKey;
      return typeof rk === 'string' && rk.includes('/api/');
    });
    expect(apiRoutes).toHaveLength(httpRouteKeys.length);
  });

  test('defines the WebSocket routes ($connect/$disconnect/$default + actions)', () => {
    const wsRouteKeys = [
      '$connect',
      '$disconnect',
      '$default',
      'createRoom',
      'joinRoom',
      'startGame',
      'submitAnswer',
      'nextQuestion',
      'endGame',
    ];
    for (const routeKey of wsRouteKeys) {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: routeKey,
      });
    }
  });

  test('provisions a WebSocket stage', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: 'prod',
      AutoDeploy: true,
    });
  });

  test('the WebSocket Lambda role can call execute-api ManageConnections', () => {
    // grantManageConnections attaches an IAM policy allowing the
    // execute-api:ManageConnections action for the @connections endpoint.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'execute-api:ManageConnections',
            Effect: 'Allow',
          }),
        ]),
      }),
    });
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
    template.hasOutput('WebSocketEndpoint', {});
    expect(() => template.hasOutput('CloudFrontDomain', {})).toThrow();
  });
});
