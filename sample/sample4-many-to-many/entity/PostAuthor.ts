import {PrimaryGeneratedColumn, Column, Table, ManyToMany} from "../../../src/index";
import {Post} from "./Post";

@Table("sample4_post_author")
export class PostAuthor {

    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    name: string;

    @ManyToMany(type => Post, post => post.authors)
    posts: Post[];

}