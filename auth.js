const google = require('googleapis')
const axios = require('axios')
const OAuthFlowBrowser = require('./flow')

// const { askClientIds } = require('./utils/ask-client-ids')
// const { initAuth } = require('./utils/init-auth')
// const { CLIENT_ID, CLIENT_SECRET, TOKEN_FIELDS } = require('./utils/constants')

class GoogleOAuth2 {
  constructor(options = {}) {
    this.refreshTokenEndpoint = 'https://www.googleapis.com/oauth2/v4/token'
    this.validateTokenEndpoint =
      'https://www.googleapis.com/oauth2/v3/tokeninfo'
    this.oAuthFlowTimeoutMilliSeconds = 10 * 1000
    this.scope = options.scope
    this.oauth = {
      ...options.oauth,
    }
    this.user = {
      ...options.userCredentials,
    }
    this.token = {}
    this.loadTokenFromCache = options.tokenCache.load
    this.saveTokenToCache = options.tokenCache.save
  }

  async refreshAccessToken(refreshToken) {
    if (!refreshToken) {
      try {
        if (this.token.refresh_token === undefined) {
          throw new Error()
        }
      } catch (err) {
        try {
          this.token = await this.loadTokenFromCache()
        } catch (err) {
          throw err
        }
      }
      refreshToken = this.token.refresh_token
    }

    try {
      const response = await axios.post(this.refreshTokenEndpoint, {
        client_id: this.oauth.clientId,
        client_secret: this.oauth.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      })
      // res = {
      //   access_token:
      //     'ya29.a0AfH6SMDiqC_L-BIuTjNyaN7SeXztrSlipjx…Vq2ZoTVwaZoOw0bPH3RLEk-T-Hsx6X9xAkuuzkNsy',
      //   expires_in: 3599,
      //   scope: 'https://www.googleapis.com/auth/photoslibrary.readonly',
      //   token_type: 'Bearer',
      // }
      let expiryDate = new Date(Date.now() + response.data.expires_in)

      this.token.access_token = response.data.access_token
      this.token.expiry_date = expiryDate.getTime()

      try {
        this.saveTokenToCache(this.token)
      } catch (err) {
        console.log('Failed to save refreshed token to cache.')
        console.log('Err:  ', err)
      }
    } catch (err) {
      throw err
    }

    return this.token.access_token
  }

  async runOAuthFlow() {
    // clear the old token data
    this.token = {}

    try {
      this.client = new google.Auth.OAuth2Client(
        this.oauth.clientId,
        this.oauth.clientSecret,
        this.oauth.callbackURL
      )

      /*
          While generating the auth URL, its possible to supply "prompt" of 'none'.
          If this does not work, go back to setting as 'consent',
          DOCS: https://googleapis.dev/nodejs/google-auth-library/latest/interfaces/GenerateAuthUrlOpts.html#prompt
      */
      const authUrl = this.client.generateAuthUrl({
        access_type: 'offline',
        scope: this.scope,
        prompt: 'consent',
        login_hint: this.user.email,
      })

      const flow = new OAuthFlowBrowser(this.user.email, this.user.password)
      await flow.runFlow(authUrl)
    } catch (err) {
      throw err
    }
  }

  async getTokenFromCode(code) {
    try {
      this.client = new google.Auth.OAuth2Client(
        this.oauth.clientId,
        this.oauth.clientSecret,
        this.oauth.callbackURL
      )
      const { tokens } = await this.client.getToken(code)

      this.token = tokens
      return tokens
    } catch (err) {
      throw err
    }
  }

  expressOAuthRouter(express) {
    const authRouter = express.Router()

    authRouter.get('/', async (req) => {
      if (req.query.code) {
        try {
          const token = await this.getTokenFromCode(req.query.code)
          await this.saveTokenToCache(token)
        } catch (err) {
          console.log('Failed Google OAuth Authorization')
          console.log('Err:  ', err)
          throw err
        }
        console.log('Google OAuth Authorization Complete')
      } else {
        console.log('Failed Google OAuth Authorization.')
        throw new Error('No Auth Code Returned to Callback.')
      }
    })

    return authRouter
  }

  verifyToken() {
    let expired = true
    let expirationDate
    if (this.token.expiry_date) {
      const nowDate = new Date()
      expirationDate = new Date(this.token.expiry_date)
      expired = expirationDate.getTime() < nowDate.getTime()
    } else {
      throw new Error(
        'Failed to validate Google OAuth Token.  Does not contain and expiry date.'
      )
    }
    if (expired) {
      throw new Error(
        `Google OAuth token has expired.  Expiration date: ${expirationDate.getTime()}`
      )
    } else {
      return true
    }
  }

  async getAccessToken() {
    if (Object.entries(this.token).length === 0) {
      try {
        this.token = await this.loadTokenFromCache()
      } catch (err) {
        throw err
      }
    }

    // Verify the current token
    try {
      this.verifyToken()
    } catch (err) {
      console.log('Failed to verify current OAuth Token.')
      console.log('Err:  ', err)

      // Refresh access token with refresh token
      try {
        console.log('Refreshing Google OAuth token.')
        await this.refreshAccessToken()
      } catch (err) {
        console.log('Failed to refresh OAuth token.')
        console.log('Err:   ', err)

        // Regenerate token with new OAuth flow
        //  But first... Snag the old token obj
        const previousToken = JSON.stringify(this.token)
        try {
          console.log('Initiating new Google OAuth flow.')
          await this.runOAuthFlow()
        } catch (err) {
          console.log('Failed to complete OAuth flow.')
          console.log('Err:   ', err)
        }

        // Look for the cached token object to update.
        //  Cannot use the instances this.token because
        //  express doesn't share class instance accross routes
        //  and the cached token is the only stateful source
        let isUpdated = false
        let isTimeout = false
        const maxAttempts = 5
        let attempt = 0
        while (!isUpdated && !isTimeout) {
          attempt += 1
          console.log(
            `Polling for updated Google OAuth token:  Attempt ${attempt}...`
          )
          try {
            const tokens = await Promise.all([
              this.loadTokenFromCache(),
              new Promise((resolve) => {
                setTimeout(
                  resolve,
                  this.oAuthFlowTimeoutMilliSeconds / maxAttempts,
                  previousToken
                )
              }),
            ])
            if (tokens[1] !== JSON.stringify(tokens[0])) {
              this.token = tokens[0]
              this.saveTokenToCache(this.token)
              isUpdated = true
            }
          } catch {
            console.log('Failed to retrieve cached token during attempt.')
          }

          if (attempt === maxAttempts) {
            isTimeout = true
            console.log('Failed to retrieve token from OAuth flow.')
            throw new Error(
              'Reached max retries while polling for updated OAuth token.'
            )
          }
        }
      }
    }

    return this.token.access_token
  }
}

module.exports = GoogleOAuth2
