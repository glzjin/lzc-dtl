const inquirer = require('inquirer');
const YAML = require('yaml');
const fs = require('fs-extra');
const path = require('path');
const archiver = require('archiver');

// 新增：获取目录下的文件列表
async function getFilesList(extensions) {
    const files = await fs.readdir(process.cwd());
    return files.filter(file => {
        if (!extensions) return true;
        const ext = path.extname(file).toLowerCase();
        return extensions.includes(ext);
    });
}

async function convertApp(options = {}) {
    let answers;
    
    // 如果没有通过命令行参数提供完整信息，则通过交互式提示收集
    if (!options.nonInteractive) {
        const questions = [];
        
        if (!options.name) {
            questions.push({
                type: 'input',
                name: 'name',
                message: '请输入应用名称：'
            });
        }
        if (!options.package) {
            questions.push({
                type: 'input',
                name: 'package',
                message: '请输入应用包名：'
            });
        }
        if (!options.description) {
            questions.push({
                type: 'input',
                name: 'description',
                message: '请输入应用描述：'
            });
        }
        if (!options.homepage) {
            questions.push({
                type: 'input',
                name: 'homepage',
                message: '请输入应用首页：'
            });
        }
        if (!options.author) {
            questions.push({
                type: 'input',
                name: 'author',
                message: '请输入作者：'
            });
        }
        if (options.backgroundTask === undefined || options.backgroundTask === null) {
            questions.push({
                type: 'confirm',
                name: 'background_task',
                message: '是否开机自启？'
            });
        }
        if (options.multiInstance === undefined || options.multiInstance === null) {
            questions.push({
                type: 'confirm',
                name: 'multi_instance',
                message: '是否多用户共享？'
            });
        }
        if (!options.publicPaths) {
            questions.push({
                type: 'input',
                name: 'public_paths',
                message: '需要对外暴露的页面（用逗号分隔）：',
                default: '/'
            });
        }
        if (!options.subdomain) {
            questions.push({
                type: 'input',
                name: 'subdomain',
                message: '请输入子域名：'
            });
        }

        const promptAnswers = await inquirer.prompt(questions);
        answers = {
            ...options,
            ...promptAnswers,
            background_task: options.backgroundTask !== undefined ? options.backgroundTask : promptAnswers.background_task,
            multi_instance: options.multiInstance !== undefined ? options.multiInstance : promptAnswers.multi_instance,
            public_paths: options.publicPaths || promptAnswers.public_paths
        };
    } else {
        // 使用命令行参数时，确保这两个值有效
        if (options.backgroundTask === undefined || options.backgroundTask === null) {
            throw new Error('在非交互模式下必须指定 --background-task 选项');
        }
        if (options.multiInstance === undefined || options.multiInstance === null) {
            throw new Error('在非交互模式下必须指定 --multi-instance 选项');
        }
        
        answers = {
            name: options.name,
            package: options.package,
            description: options.description,
            homepage: options.homepage,
            author: options.author,
            background_task: options.backgroundTask,
            multi_instance: options.multiInstance,
            public_paths: options.publicPaths,
            subdomain: options.subdomain
        };
    }

    // 处理图标文件
    let iconPath = options.icon;
    if (!iconPath) {
        const imageFiles = await getFilesList(['.png', '.jpg', '.jpeg', '.gif']);
        if (imageFiles.length === 0) {
            throw new Error('当前目录下没有找到图片文件');
        }

        const iconAnswer = await inquirer.prompt([{
            type: 'list',
            name: 'iconPath',
            message: '请选择图标文件：',
            choices: imageFiles,
            pageSize: 10
        }]);
        iconPath = iconAnswer.iconPath;
    }

    // 处理 docker-compose.yml
    let composePath = options.compose;
    if (!composePath) {
        const yamlFiles = await getFilesList(['.yml', '.yaml']);
        if (yamlFiles.length === 0) {
            throw new Error('当前目录下没有找到 YAML 文件');
        }

        const composeAnswer = await inquirer.prompt([{
            type: 'list',
            name: 'composePath',
            message: '请选择 docker-compose 文件：',
            choices: yamlFiles,
            pageSize: 10
        }]);
        composePath = composeAnswer.composePath;
    }

    // 验证选择的文件
    try {
        const composeContent = await fs.readFile(composePath, 'utf8');
        const composeData = YAML.parse(composeContent);
        
        // 验证是否是有效的 docker-compose 文件
        if (!composeData.services) {
            throw new Error('选择的文件不是有效的 docker-compose 文件');
        }

        // 获取服务列表用于路由选择
        const services = Object.keys(composeData.services);

        // 生成 manifest.yml
        const manifest = {
            'lzc-sdk-version': '0.1',
            name: answers.name,
            package: answers.package,
            version: '0.0.1',
            description: answers.description,
            homepage: answers.homepage,
            author: answers.author,
            application: {
                background_task: answers.background_task,
                multi_instance: answers.multi_instance,
                public_path: answers.public_paths.split(','),
                subdomain: answers.subdomain
            },
            services: {}
        };

        // 处理路由规则
        let routes = [];
        if (!options.routes) {
            const routeTypes = [
                { name: 'HTTP路由', value: 'http' },
                { name: 'HTTPS路由', value: 'https' },
                { name: 'TCP/UDP端口暴露', value: 'port' },
                { name: '从docker-compose读取端口', value: 'from_compose' }
            ];

            // 询问是否需要添加更多路由
            let addMore = true;
            while (addMore) {
                // 选择路由类型
                const routeTypeAnswer = await inquirer.prompt([{
                    type: 'list',
                    name: 'type',
                    message: '请选择路由类型：',
                    choices: routeTypes
                }]);

                if (routeTypeAnswer.type === 'from_compose') {
                    // 从 docker-compose 读取端口
                    for (const [serviceName, service] of Object.entries(composeData.services)) {
                        if (service.ports) {
                            for (const portMapping of service.ports) {
                                const [hostPort, containerPort] = portMapping.split(':');
                                
                                // 询问是否要添加这个端口映射
                                const usePortAnswer = await inquirer.prompt([{
                                    type: 'confirm',
                                    name: 'use',
                                    message: `是否添加服务 ${serviceName} 的端口映射 ${portMapping}？`,
                                    default: true
                                }]);

                                if (usePortAnswer.use) {
                                    // 询问路由类型
                                    const routeTypeForPort = await inquirer.prompt([{
                                        type: 'list',
                                        name: 'type',
                                        message: `请选择 ${serviceName}:${containerPort} 的路由类型：`,
                                        choices: [
                                            { name: 'HTTP路由', value: 'http' },
                                            { name: 'HTTPS路由', value: 'https' },
                                            { name: 'TCP/UDP端口暴露', value: 'port' }
                                        ]
                                    }]);

                                    if (routeTypeForPort.type === 'port') {
                                        // 询问协议类型
                                        const protocolAnswer = await inquirer.prompt([{
                                            type: 'list',
                                            name: 'protocol',
                                            message: '请选择协议：',
                                            choices: ['tcp', 'udp']
                                        }]);

                                        routes.push({
                                            type: 'ingress',
                                            config: {
                                                protocol: protocolAnswer.protocol,
                                                port: parseInt(containerPort),
                                                service: serviceName
                                            }
                                        });
                                    } else {
                                        // HTTP/HTTPS路由
                                        const pathAnswer = await inquirer.prompt([{
                                            type: 'input',
                                            name: 'path',
                                            message: '请输入路由路径（如 /api/）：',
                                            default: '/'
                                        }]);

                                        routes.push({
                                            type: 'http',
                                            config: {
                                                path: pathAnswer.path,
                                                target: `${routeTypeForPort.type}://${serviceName}.${answers.package}.lzcapp:${containerPort}/`
                                            }
                                        });
                                    }
                                }
                            }
                        }
                    }
                } else if (routeTypeAnswer.type === 'port') {
                    // TCP/UDP端口暴露配置
                    const portConfig = await inquirer.prompt([
                        {
                            type: 'list',
                            name: 'protocol',
                            message: '请选择协议：',
                            choices: ['tcp', 'udp']
                        },
                        {
                            type: 'input',
                            name: 'port',
                            message: '请输入端口号：',
                            validate: (input) => {
                                const port = parseInt(input);
                                if (isNaN(port) || port < 1 || port > 65535) {
                                    return '请输入有效的端口号（1-65535）';
                                }
                                return true;
                            }
                        },
                        {
                            type: 'list',
                            name: 'service',
                            message: '请选择服务：',
                            choices: services
                        }
                    ]);

                    routes.push({
                        type: 'ingress',
                        config: {
                            protocol: portConfig.protocol,
                            port: parseInt(portConfig.port),
                            service: portConfig.service
                        }
                    });
                } else {
                    // HTTP/HTTPS路由配置
                    const httpConfig = await inquirer.prompt([
                        {
                            type: 'input',
                            name: 'path',
                            message: '请输入路由路径（如 /api/）：',
                            default: '/'
                        },
                        {
                            type: 'list',
                            name: 'service',
                            message: '请选择服务：',
                            choices: services
                        },
                        {
                            type: 'input',
                            name: 'port',
                            message: '请输入服务端口：',
                            validate: (input) => {
                                const port = parseInt(input);
                                if (isNaN(port) || port < 1 || port > 65535) {
                                    return '请输入有效的端口号（1-65535）';
                                }
                                return true;
                            }
                        }
                    ]);

                    const protocol = routeTypeAnswer.type;
                    routes.push({
                        type: 'http',
                        config: {
                            path: httpConfig.path,
                            target: `${protocol}://${httpConfig.service}.${answers.package}.lzcapp:${httpConfig.port}/`
                        }
                    });
                }

                // 询问是否继续添加路由
                const continueAnswer = await inquirer.prompt([{
                    type: 'confirm',
                    name: 'addMore',
                    message: '是否继续添加路由？',
                    default: false
                }]);

                addMore = continueAnswer.addMore;
            }
        } else {
            // 处理命令行参数中的路由配置
            routes = options.routes;
        }

        // 添加路由配置
        const httpRoutes = routes
            .filter(r => r.type === 'http')
            .map(r => `${r.config.path}=${r.config.target}`);
        
        if (httpRoutes.length > 0) {
            manifest.application.routes = httpRoutes;
        }

        // 添加端口暴露配置
        const ingressRoutes = routes.filter(r => r.type === 'ingress');
        if (ingressRoutes.length > 0) {
            manifest.application.ingress = ingressRoutes.map(r => ({
                protocol: r.config.protocol,
                port: r.config.port,
                service: r.config.service
            }));
        }

        // 转换 services
        for (const [name, service] of Object.entries(composeData.services)) {
            if (name === 'app') continue;

            manifest.services[name] = {
                image: service.image
            };

            if (service.environment) {
                // 转换 environment 格式
                if (Array.isArray(service.environment)) {
                    // 如果是数组格式，直接使用
                    manifest.services[name].environment = service.environment;
                } else if (typeof service.environment === 'object') {
                    // 如果是对象格式，转换为 key=value 数组
                    manifest.services[name].environment = Object.entries(service.environment).map(
                        ([key, value]) => `${key}=${value}`
                    );
                }
            }

            if (service.binds) {
                manifest.services[name].binds = service.binds.map(bind => {
                    const [src, dest] = bind.split(':');
                    return `/lzcapp/var/${path.basename(src)}:${dest}`;
                });
            }

            if (service.command) {
                manifest.services[name].command = service.command;
            }

            if (service.depends_on) {
                manifest.services[name].depends_on = service.depends_on;
            }
        }

        // 写入 manifest.yml
        await fs.writeFile('manifest.yml', YAML.stringify(manifest));

        // 复制图标文件
        await fs.copy(iconPath, 'icon.png');

        // 创建 lpk 文件
        const output = fs.createWriteStream(`${answers.package}.lpk`);
        const archive = archiver('zip');

        archive.pipe(output);
        archive.file('manifest.yml', { name: 'manifest.yml' });
        archive.file('icon.png', { name: 'icon.png' });

        await archive.finalize();

        console.log('转换完成！');
    } catch (error) {
        throw new Error(`处理文件时出错：${error.message}`);
    }
}

module.exports = { convertApp }; 