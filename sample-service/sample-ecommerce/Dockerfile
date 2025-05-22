FROM node:23.11.1-alpine3.21

WORKDIR /usr/src/app

COPY . .
RUN yarn
EXPOSE 8080
RUN yarn build

CMD ["yarn", "start:prod"]
