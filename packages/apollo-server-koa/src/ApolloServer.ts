import * as Koa from 'koa';
import * as Router from 'koa-router';
import * as koaCorsMiddleware from '@koa/cors';
import * as bodyParser from 'koa-bodyparser';
import { OptionsJson } from 'body-parser';
import { createServer, Server as HttpServer } from 'http';
import gui from 'graphql-playground-middleware-koa';
import { ApolloServerBase, formatApolloErrors } from 'apollo-server-core';

import { graphqlKoa, KoaHandler } from './koaApollo';

import {
  processRequest as processFileUploads,
  GraphQLUpload,
} from 'apollo-upload-server';

const gql = String.raw;

export interface ServerRegistration {
  app: Koa;
  server: ApolloServerBase<Koa.BaseRequest>;
  router?: Router;
  path?: string;
  cors?: koaCorsMiddleware.Options;
  bodyParserConfig?: OptionsJson;
  onHealthCheck?: (ctx: Koa.BaseContext) => Promise<any>;
  disableHealthCheck?: boolean;
  //https://github.com/jaydenseric/apollo-upload-server#options
  uploads?: boolean | Record<string, any>;
}

const fileUploadMiddleware = (
  uploadsConfig: Record<string, any>,
  server: ApolloServerBase<Koa.BaseRequest>,
) => (ctx: Koa.Context, next: Function) => {
  const { req, res } = ctx;

  if (ctx.is('multipart/form-data')) {
    processFileUploads(req, uploadsConfig)
      .then(body => {
        ctx.body = body;
        next();
      })
      .catch(error => {
        if (error.status && error.expose) ctx.status = error.status;

        next(
          formatApolloErrors([error], {
            formatter: server.requestOptions.formatError,
            debug: server.requestOptions.debug,
            logFunction: server.requestOptions.logFunction,
          }),
        );
      });
  } else {
    next();
  }
};

export const registerServer = async ({
  app,
  server,
  router,
  path,
  cors,
  bodyParserConfig,
  disableHealthCheck,
  onHealthCheck,
  uploads,
}: ServerRegistration) => {
  if (!path) path = '/graphql';

  // in case no router is passed, create a custom one
  if (!router) {
    router = new Router();

    app.use(router.routes());
    app.use(router.allowedMethods());
  }

  if (!disableHealthCheck) {
    //uses same path as engine
    router.get('/.well-known/apollo/server-health', (ctx, next) => {
      const { req } = ctx;

      //Response follows https://tools.ietf.org/html/draft-inadarei-api-health-check-01
      ctx.type = 'application/health+json';

      if (onHealthCheck) {
        onHealthCheck(ctx)
          .then(() => {
            ctx.body = { status: 'pass' };
          })
          .catch(() => {
            ctx.status = 503;
            ctx.body = { status: 'fail' };
          });
      } else {
        ctx.body = { status: 'pass' };
      }
    });
  }

  let uploadsMiddleware;
  if (uploads !== false) {
    server.enhanceSchema({
      typeDefs: gql`
        scalar Upload
      `,
      resolvers: { Upload: GraphQLUpload },
    });

    uploadsMiddleware = fileUploadMiddleware(
      typeof uploads !== 'boolean' ? uploads : {},
      server,
    );
  }

  server.use({
    path,
    getHttp: () => createServer(app.callback()),
  });

  const middlewareStack = [];

  router.all(
    path,
    koaCorsMiddleware(cors),
    bodyParser(bodyParserConfig),
    uploadsMiddleware ? uploadsMiddleware : (ctx, next) => next(),
    async (ctx: Koa.Context, next) => {
      // make sure we check to see if graphql gui should be on
      if (!server.disableTools && ctx.method === 'GET') {
        //perform more expensive content-type check only if necessary
        let prefersHTML;

        switch (ctx.accepts(['text/html', 'application/json'])) {
          case 'text/html':
            prefersHTML = true;
            break;
          // no-default
        }

        if (prefersHTML) {
          return gui({
            endpoint: path,
            subscriptionEndpoint: server.subscriptionsPath,
          })(ctx, next);
        }
      }

      ctx.status = 200;
      const fn = graphqlKoa(server.graphQLServerOptionsForRequest.bind(server));
      ctx.status = 201;
      await fn(ctx);
      ctx.status = 203;

      next();
    },
  );
};
